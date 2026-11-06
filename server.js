'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { probe, checkEnv, hasCookies, cookieFilePath } = require('./src/ytdlp');
const { TaskManager } = require('./src/tasks');
const { DOWNLOAD_DIR, COOKIE_DIR, FORMAT_PRESETS } = require('./src/config');

const app = express();
const PORT = Number(process.env.PORT) || 8899;
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json({ limit: '20mb' }));
app.use(express.text({ type: 'text/plain', limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const tasks = new TaskManager();

/** SSE 客户端集合 */
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

tasks.on('task:update', (t) => broadcast('task', t));
tasks.on('task:progress', (t) => broadcast('progress', t));
tasks.on('task:log', (l) => broadcast('log', l));
tasks.on('task:remove', (d) => broadcast('removed', d));

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

// 环境检测结果缓存：后台刷新，接口立即返回，避免阻塞事件循环
let envCache = null;
let envRefreshing = false;

async function refreshEnv() {
  if (envRefreshing) return;
  envRefreshing = true;
  try {
    envCache = await checkEnv(true);
  } catch {
    envCache = envCache || { python: false, ytDlp: null, ffmpeg: false, ffprobe: false };
  } finally {
    envRefreshing = false;
  }
}
refreshEnv();
setInterval(refreshEnv, 30000).unref();

app.get('/api/status', (req, res) => {
  const env = envCache || { python: false, ytDlp: null, ffmpeg: false, ffprobe: false };
  res.json({
    ok: env.python && env.ffmpeg,
    env,
    cookies: hasCookies(),
    formats: Object.entries(FORMAT_PRESETS).map(([k, v]) => ({ key: k, label: v.label })),
    downloadDir: DOWNLOAD_DIR,
    activeTasks: tasks.list().filter((t) => t.status === 'running' || t.status === 'queued').length,
  });
});

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

app.post('/api/probe', async (req, res) => {
  const { url, referer = '', userAgent = '', useCookies = false } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '缺少 url 参数' });
  }
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return res.status(400).json({ error: 'URL 必须以 http:// 或 https:// 开头' });
  }
  try {
    const info = await probe(trimmed, { referer, userAgent, useCookies: !!useCookies });
    res.json({ ok: true, info });
  } catch (err) {
    const msg = (err.stderr || err.message || '解析失败').trim().split(/\r?\n/).slice(-4).join('\n');
    res.status(400).json({ error: msg });
  }
});

/* ------------------------------------------------------------------ */
/* 下载任务                                                            */
/* ------------------------------------------------------------------ */

app.post('/api/download', (req, res) => {
  const {
    url, preset = 'mp4', formatId = null,
    referer = '', userAgent = '', useCookies = false, title = null,
  } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '缺少 url 参数' });
  }
  if (!FORMAT_PRESETS[preset]) {
    return res.status(400).json({ error: `未知的输出格式: ${preset}` });
  }
  const task = tasks.create({
    url: url.trim(), preset, formatId,
    referer, userAgent, useCookies: !!useCookies, title,
  });
  res.json({ ok: true, task: tasks.sanitize(task) });
});

app.get('/api/tasks', (req, res) => {
  res.json({ ok: true, tasks: tasks.list() });
});

app.get('/api/tasks/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  res.json({ ok: true, task: tasks.sanitize(t) });
});

app.post('/api/tasks/:id/cancel', (req, res) => {
  const ok = tasks.cancel(req.params.id);
  res.json({ ok });
});

app.delete('/api/tasks/:id', (req, res) => {
  const ok = tasks.remove(req.params.id);
  res.json({ ok });
});

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseClients.add(res);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

/* ------------------------------------------------------------------ */
/* Cookie 管理                                                         */
/* ------------------------------------------------------------------ */

app.post('/api/cookies', (req, res) => {
  const content = typeof req.body === 'string' ? req.body : '';
  if (!content || content.length < 10) {
    return res.status(400).json({ error: 'cookies 内容为空' });
  }
  if (!/# Netscape HTTP Cookie File/i.test(content)) {
    return res.status(400).json({
      error: '格式不正确，需要 Netscape 格式的 cookies.txt（第一行为 # Netscape HTTP Cookie File）',
    });
  }
  fs.writeFileSync(cookieFilePath(), content, 'utf8');
  res.json({ ok: true, path: cookieFilePath(), size: content.length });
});

app.delete('/api/cookies', (req, res) => {
  try {
    if (fs.existsSync(cookieFilePath())) fs.unlinkSync(cookieFilePath());
  } catch { /* ignore */ }
  res.json({ ok: true });
});

app.get('/api/cookies', (req, res) => {
  res.json({ ok: true, exists: hasCookies(), path: cookieFilePath() });
});

/* ------------------------------------------------------------------ */
/* 文件管理                                                            */
/* ------------------------------------------------------------------ */

function listFiles() {
  try {
    return fs.readdirSync(DOWNLOAD_DIR)
      .filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'))
      .map((f) => {
        const st = fs.statSync(path.join(DOWNLOAD_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

app.get('/api/files', (req, res) => {
  res.json({ ok: true, files: listFiles(), dir: DOWNLOAD_DIR });
});

app.get('/api/files/:name', (req, res) => {
  const name = path.basename(decodeURIComponent(req.params.name));
  const fp = path.join(DOWNLOAD_DIR, name);
  if (!fp.startsWith(DOWNLOAD_DIR) || !fs.existsSync(fp)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  const stat = fs.statSync(fp);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  fs.createReadStream(fp).pipe(res);
});

/** 浏览器端直接播放（预览） */
app.get('/api/preview/:name', (req, res) => {
  const name = path.basename(decodeURIComponent(req.params.name));
  const fp = path.join(DOWNLOAD_DIR, name);
  if (!fp.startsWith(DOWNLOAD_DIR) || !fs.existsSync(fp)) {
    return res.status(404).end();
  }
  const ext = path.extname(name).toLowerCase();
  const mime = {
    '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
    '.mov': 'video/quicktime', '.flv': 'video/x-flv', '.ts': 'video/mp2t',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  const stat = fs.statSync(fp);
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(fp).pipe(res);
  }
});

app.delete('/api/files/:name', (req, res) => {
  const name = path.basename(decodeURIComponent(req.params.name));
  const fp = path.join(DOWNLOAD_DIR, name);
  if (!fp.startsWith(DOWNLOAD_DIR) || !fs.existsSync(fp)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  fs.unlinkSync(fp);
  res.json({ ok: true });
});

/** 打开下载目录 */
app.post('/api/open-folder', (req, res) => {
  const { exec } = require('child_process');
  exec(`explorer.exe "${DOWNLOAD_DIR}"`, { windowsHide: true }, () => {});
  res.json({ ok: true, dir: DOWNLOAD_DIR });
});

/* ------------------------------------------------------------------ */

app.listen(PORT, HOST, () => {
  console.log(`\n  在线视频下载工具已启动`);
  console.log(`  → http://${HOST}:${PORT}`);
  console.log(`  下载目录: ${DOWNLOAD_DIR}\n`);
});
