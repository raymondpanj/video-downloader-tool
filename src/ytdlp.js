'use strict';

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EOL } = require('os');
const {
  PYTHON, YT_DLP_MODULE, FFMPEG_DIR, DEFAULT_UA, DOWNLOAD_DIR,
} = require('./config');

/**
 * 生成 yt-dlp 基础参数。
 * 注意：yt-dlp 以 Python 模块方式调用，规避 GitHub 二进制下载（网络受限）。
 */
function baseArgs() {
  return [
    '-m', YT_DLP_MODULE,
    '--no-warnings',
    '--ignore-config',
    '--ffmpeg-location', FFMPEG_DIR,
    '--user-agent', DEFAULT_UA,
    '--no-check-certificate',
  ];
}

function cookieFilePath() {
  return path.join(require('./config').COOKIE_DIR, 'cookies.txt');
}

function hasCookies() {
  const p = cookieFilePath();
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/**
 * 组装鉴权 / header 相关参数。
 * @param {object} opts
 * @param {boolean} opts.useCookies  是否附带 cookies.txt
 * @param {string}  opts.referer    自定义 Referer
 * @param {string}  opts.userAgent   自定义 UA
 */
function authArgs({ useCookies = false, referer = '', userAgent = '' } = {}) {
  const args = [];
  if (useCookies && hasCookies()) {
    args.push('--cookies', cookieFilePath());
  }
  if (referer) {
    args.push('--referer', referer);
  }
  if (userAgent) {
    args.push('--user-agent', userAgent);
  }
  return args;
}

/**
 * 解析 URL，返回元信息与可用格式列表。
 * @param {string} url
 * @param {object} opts 同 authArgs
 * @returns {Promise<object>}
 */
async function probe(url, opts = {}) {
  const args = [
    ...baseArgs(),
    ...authArgs(opts),
    '--dump-single-json',
    '--no-playlist',
    '--flat-playlist',
    url,
  ];
  const { stdout, stderr, code } = await runProcess(args, { timeout: 120000 });

  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch {
    raw = null;
  }

  if (!raw) {
    // yt-dlp 失败：stderr 里有真实原因（如网络不通、格式不支持、需登录）
    const reason = extractError(stderr) || `yt-dlp 未能解析该链接${code ? `（退出码 ${code}）` : ''}`;
    throw new Error(reason);
  }

  return normalizeInfo(raw);
}

/** 从 yt-dlp 的 stderr 中提取人类可读的错误原因 */
function extractError(stderr) {
  if (!stderr) return '';
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 优先取 ERROR 行
  const errLine = lines.filter((l) => /^ERROR:?\s*/i.test(l) || /\[error\]/i.test(l));
  const pick = (errLine.length ? errLine : lines.slice(-3)).slice(-2);
  const text = pick.join('\n')
    .replace(/^\s*ERROR:?\s*/i, '')
    .replace(/^\s*\[\d{4}-\d{2}-\d{2}[\s\d:]*\]\s*\[error\]\s*/i, '')
    .trim();
  return text.slice(0, 400);
}

function normalizeInfo(raw) {
  const formats = (raw.formats || []).map((f) => ({
    formatId: f.format_id,
    ext: f.ext,
    protocol: f.protocol || (f.url && f.url.startsWith('http') ? 'https' : 'http'),
    height: f.height || null,
    width: f.width || null,
    fps: f.fps || null,
    vcodec: f.vcodec || null,
    acodec: f.acodec || null,
    filesize: f.filesize || f.filesize_approx || null,
    tbr: f.tbr || null,
    abr: f.abr || null,
    quality: f.format_note || f.quality || null,
    hasVideo: !!(f.vcodec && f.vcodec !== 'none'),
    hasAudio: !!(f.acodec && f.acodec !== 'none'),
    url: f.url || null,
  }));

  // 全部格式（未分离的整段流）
  if (raw.url && !formats.length) {
    formats.push({
      formatId: raw.format_id || 'default',
      ext: raw.ext,
      protocol: raw.protocol || 'https',
      height: raw.height || null,
      width: raw.width || null,
      fps: raw.fps || null,
      vcodec: raw.vcodec || null,
      acodec: raw.acodec || null,
      filesize: raw.filesize || raw.filesize_approx || null,
      tbr: raw.tbr || null,
      abr: raw.abr || null,
      quality: raw.format_note || 'default',
      hasVideo: !!(raw.vcodec && raw.vcodec !== 'none'),
      hasAudio: !!(raw.acodec && raw.acodec !== 'none'),
      url: raw.url || null,
    });
  }

  return {
    id: raw.id || null,
    title: raw.title || '未命名',
    uploader: raw.uploader || raw.uploader_id || null,
    duration: raw.duration || null,
    durationString: raw.duration_string || null,
    thumbnail: raw.thumbnail || null,
    webpageUrl: raw.webpage_url || raw.original_url || null,
    extractor: raw.extractor_key || raw.extractor || null,
    isLive: !!raw.is_live,
    viewCount: raw.view_count || null,
    likeCount: raw.like_count || null,
    uploadDate: raw.upload_date || null,
    description: raw.description || null,
    formats,
  };
}

/**
 * 执行命令并收集 stdout/stderr。
 */
function runProcess(args, { timeout = 0, cwd = process.cwd(), onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let stdout = '';
    let stderr = '';
    let timer = null;

    if (timeout > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`命令执行超时（${timeout}ms）`));
      }, timeout);
    }

    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (onStdout) onStdout(chunk);
    });
    child.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (onStderr) onStderr(chunk);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * 启动下载，返回可控的子进程句柄。
 */
function spawnDownload(args, { onStdout, onStderr, cwd } = {}) {
  const child = spawn(PYTHON, args, {
    cwd: cwd || DOWNLOAD_DIR,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  if (onStdout) child.stdout.on('data', onStdout);
  if (onStderr) child.stderr.on('data', onStderr);
  return child;
}

/** 检查运行环境是否就绪 */
let envCache = null;
let envCacheAt = 0;
const ENV_TTL = 30000;

async function checkEnv(force = false) {
  const now = Date.now();
  if (!force && envCache && now - envCacheAt < ENV_TTL) {
    return envCache;
  }
  const result = { python: false, ytDlp: null, ffmpeg: false, ffprobe: false };
  try {
    const { stdout } = await runProcess(
      ['-m', YT_DLP_MODULE, '--version'],
      { timeout: 30000 },
    );
    result.python = true;
    result.ytDlp = stdout.trim();
  } catch {
    result.python = false;
  }
  const ff = path.join(FFMPEG_DIR, 'ffmpeg.exe');
  const fp = path.join(FFMPEG_DIR, 'ffprobe.exe');
  result.ffmpeg = fs.existsSync(ff);
  result.ffprobe = fs.existsSync(fp);
  envCache = result;
  envCacheAt = now;
  return result;
}

module.exports = {
  baseArgs, authArgs, probe, normalizeInfo, runProcess,
  spawnDownload, checkEnv, hasCookies, cookieFilePath,
};
