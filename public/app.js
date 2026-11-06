/* 在线视频下载工具 — 前端逻辑 */

const $ = (id) => document.getElementById(id);

const state = {
  info: null,
  preset: 'mp4',
  formatId: null,
  tasks: new Map(),
  es: null,
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'all .25s';
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[i];
}

function fmtDuration(sec) {
  if (!sec && sec !== 0) return null;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ------------------------------------------------------------------ */
/* 环境检测                                                            */
/* ------------------------------------------------------------------ */

async function loadStatus() {
  try {
    const s = await api('/api/status');
    const pill = $('envPill');
    const ok = s.env.python && s.env.ffmpeg;
    pill.className = 'env-pill ' + (ok ? 'ok' : 'bad');
    const bits = [];
    if (s.env.ytDlp) bits.push('yt-dlp ' + s.env.ytDlp);
    if (s.env.ffmpeg) bits.push('ffmpeg 就绪');
    if (!s.env.ffprobe) bits.push('（无 ffprobe）');
    $('envText').textContent = ok ? bits.join(' · ') : '环境未就绪：缺少 ' + (s.env.python ? 'ffmpeg' : 'yt-dlp');
    $('footerDir').textContent = '下载目录：' + s.downloadDir;
    $('useCookies').disabled = !s.cookies;
    if (s.cookies) $('useCookies').checked = false;
  } catch (e) {
    $('envPill').className = 'env-pill bad';
    $('envText').textContent = '无法连接服务';
  }
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

async function doParse() {
  const url = $('urlInput').value.trim();
  if (!url) { toast('请先粘贴视频链接', 'err'); return; }

  const btn = $('parseBtn');
  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = '解析中';
  btn.querySelector('.spinner').hidden = false;
  $('infoCard').hidden = true;

  try {
    const data = await api('/api/probe', {
      method: 'POST',
      body: JSON.stringify({
        url,
        referer: $('refererInput').value.trim(),
        userAgent: $('uaInput').value.trim(),
        useCookies: $('useCookies').checked,
      }),
    });
    state.info = data.info;
    state.formatId = null;
    renderInfo(data.info);
    $('infoCard').hidden = false;
    $('infoCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    toast(e.message || '解析失败', 'err');
    showParseError(e.message);
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-text').textContent = '解析';
    btn.querySelector('.spinner').hidden = true;
  }
}

function showParseError(msg) {
  let box = $('parseError');
  if (!box) {
    box = document.createElement('div');
    box.id = 'parseError';
    box.className = 'task-err';
    box.style.marginTop = '14px';
    $('infoCard').parentNode.insertBefore(box, $('infoCard'));
  }
  box.textContent = '解析失败：' + msg;
}

function clearParseError() {
  const box = $('parseError');
  if (box) box.remove();
}

function renderInfo(info) {
  clearParseError();
  $('videoTitle').textContent = info.title;

  if (info.thumbnail) {
    $('thumb').src = info.thumbnail;
    $('thumbWrap').hidden = false;
  } else {
    $('thumbWrap').hidden = true;
  }

  const tags = [];
  const dur = fmtDuration(info.duration);
  if (dur) tags.push({ t: dur, accent: true });
  if (info.uploader) tags.push({ t: info.uploader });
  if (info.extractor) tags.push({ t: info.extractor });
  if (info.viewCount) tags.push({ t: formatBytes(info.viewCount) + ' 次播放' });
  if (info.likeCount) tags.push({ t: formatBytes(info.likeCount) + ' 点赞' });
  if (info.isLive) tags.push({ t: '直播中', accent: true });

  $('metaTags').innerHTML = tags
    .map((x) => `<span class="tag${x.accent ? ' accent' : ''}">${escapeHtml(x.t)}</span>`)
    .join('');

  renderFormats(info.formats || []);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderFormats(formats) {
  const body = $('formatTableBody');
  if (!formats.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">该链接未返回可选格式</td></tr>';
    return;
  }
  const rows = formats
    .slice()
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))
    .map((f) => {
      const res = f.height ? `${f.height}p` : (f.hasAudio && !f.hasVideo ? '音频' : '—');
      const codec = [f.vcodec && f.vcodec !== 'none' ? 'V' : '', f.acodec && f.acodec !== 'none' ? 'A' : '']
        .filter(Boolean).join('+') || '—';
      return `<tr>
        <td class="mono">${escapeHtml(f.formatId)}</td>
        <td>${escapeHtml(f.ext || '—')}</td>
        <td>${escapeHtml(res)}</td>
        <td class="num">${f.filesize ? formatBytes(f.filesize) : '—'}</td>
        <td class="mono">${escapeHtml(codec)}</td>
        <td class="num"><button class="btn-mini" data-fid="${escapeHtml(f.formatId)}">选用</button></td>
      </tr>`;
    });
  body.innerHTML = rows.join('');
}

/* ------------------------------------------------------------------ */
/* 输出格式选择                                                        */
/* ------------------------------------------------------------------ */

document.querySelectorAll('.preset').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.preset').forEach((x) => x.classList.remove('active'));
    el.classList.add('active');
    state.preset = el.dataset.preset;
    state.formatId = null;
    document.querySelectorAll('.btn-mini').forEach((b) => b.classList.remove('used'));
    $('downloadBtn').disabled = false;
  });
});

document.querySelector('.preset[data-preset="mp4"]').classList.add('active');

$('formatTableBody').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-mini');
  if (!btn) return;
  const fid = btn.dataset.fid;
  if (state.formatId === fid) {
    state.formatId = null;
    btn.classList.remove('used');
    btn.textContent = '选用';
  } else {
    document.querySelectorAll('.btn-mini').forEach((b) => { b.classList.remove('used'); b.textContent = '选用'; });
    state.formatId = fid;
    btn.classList.add('used');
    btn.textContent = '已选';
  }
});

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */

async function startDownload() {
  const url = $('urlInput').value.trim();
  if (!url) { toast('请先粘贴视频链接', 'err'); return; }
  const btn = $('downloadBtn');
  btn.disabled = true;
  try {
    const data = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        url,
        preset: state.preset,
        formatId: state.formatId,
        referer: $('refererInput').value.trim(),
        userAgent: $('uaInput').value.trim(),
        useCookies: $('useCookies').checked,
        title: state.info ? state.info.title : null,
      }),
    });
    if (data.task) upsertTask(data.task);
    $('taskCard').hidden = false;
    toast('已加入下载队列', 'ok');
  } catch (e) {
    toast(e.message || '创建任务失败', 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 任务渲染                                                            */
/* ------------------------------------------------------------------ */

function upsertTask(t) {
  state.tasks.set(t.id, t);
  $('taskCard').hidden = false;
  renderTask(t);
}

function renderTask(t) {
  let el = document.getElementById('task-' + t.id);
  if (!el) {
    el = document.createElement('div');
    el.id = 'task-' + t.id;
    el.className = 'task';
    $('taskList').appendChild(el);
  }

  const stateMap = {
    queued: ['排队中', ''],
    running: [t.phase || '进行中', ''],
    completed: ['已完成', 'done'],
    failed: ['失败', 'fail'],
    canceled: ['已取消', 'cancel'],
  };
  const [label, cls] = stateMap[t.status] || [t.status, ''];

  const pct = Math.max(0, Math.min(100, Math.round(t.progress || 0)));
  const speed = t.speed ? ` · ${t.speed}` : '';
  const eta = t.eta ? ` · 剩余 ${t.eta}` : '';
  const size = t.totalSize ? ` · ${formatBytes(t.totalSize)}` : '';

  const actions = [];
  if (t.status === 'running' || t.status === 'queued') {
    actions.push(`<button class="btn-mini" data-act="cancel">取消</button>`);
  }
  if (t.status === 'completed' && t.filename) {
    actions.push(`<a class="task-link" href="/api/files/${encodeURIComponent(t.filename)}" download>下载文件</a>`);
    actions.push(`<button class="btn-mini" data-act="preview">预览</button>`);
  }
  if (t.status === 'failed' || t.status === 'canceled' || t.status === 'completed') {
    actions.push(`<button class="btn-mini" data-act="remove">移除</button>`);
  }

  el.innerHTML = `
    <div class="task-top">
      <div class="task-title" title="${escapeHtml(t.title || '')}">${escapeHtml(t.title || t.url)}</div>
      <div class="task-state ${cls}">${escapeHtml(label)}</div>
    </div>
    <div class="progress-track">
      <div class="progress-bar ${cls}" style="width:${pct}%"></div>
    </div>
    <div class="task-foot">
      <span>${pct}%${speed}${eta}${size}</span>
      <span class="grow"></span>
      ${actions.join('')}
    </div>
    ${t.error ? `<div class="task-err">${escapeHtml(t.error)}</div>` : ''}
  `;
}

$('taskList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('.task');
  const id = card.id.replace('task-', '');
  const act = btn.dataset.act;

  if (act === 'cancel') {
    await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
  } else if (act === 'remove') {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    state.tasks.delete(id);
    card.remove();
  } else if (act === 'preview') {
    const t = state.tasks.get(id);
    if (t && t.filename) window.open(`/api/preview/${encodeURIComponent(t.filename)}`, '_blank');
  }
});

$('clearTasksBtn').addEventListener('click', async () => {
  const done = Array.from(state.tasks.values()).filter(
    (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'canceled',
  );
  for (const t of done) {
    await api(`/api/tasks/${t.id}`, { method: 'DELETE' }).catch(() => {});
    state.tasks.delete(t.id);
    const el = document.getElementById('task-' + t.id);
    if (el) el.remove();
  }
  if (!state.tasks.size) $('taskCard').hidden = true;
});

/* ------------------------------------------------------------------ */
/* 文件列表                                                            */
/* ------------------------------------------------------------------ */

async function loadFiles() {
  try {
    const data = await api('/api/files');
    const list = data.files || [];
    $('filesCard').hidden = list.length === 0;
    if (!list.length) { $('fileList').innerHTML = ''; return; }

    $('fileList').innerHTML = list.map((f) => {
      const ext = (f.name.split('.').pop() || '').slice(0, 3);
      const canPreview = /\.(mp4|mkv|webm|mov|flv|ts|mp3|m4a)$/i.test(f.name);
      return `<div class="file">
        <div class="file-icon">${escapeHtml(ext)}</div>
        <div class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="file-size">${formatBytes(f.size)}</div>
        <div class="file-actions">
          ${canPreview ? `<button class="btn-mini" data-file="${escapeHtml(f.name)}" data-act="preview">预览</button>` : ''}
          <a class="btn-mini" href="/api/files/${encodeURIComponent(f.name)}" download style="text-decoration:none">下载</a>
          <button class="btn-mini" data-file="${escapeHtml(f.name)}" data-act="delete">删除</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) { /* 忽略 */ }
}

$('fileList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const name = btn.dataset.file;
  if (btn.dataset.act === 'preview') {
    window.open(`/api/preview/${encodeURIComponent(name)}`, '_blank');
  } else if (btn.dataset.act === 'delete') {
    if (!confirm(`确定删除「${name}」？`)) return;
    await api(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
    loadFiles();
  }
});

$('refreshFilesBtn').addEventListener('click', loadFiles);
$('openFolderBtn').addEventListener('click', () => api('/api/open-folder', { method: 'POST' }));

/* ------------------------------------------------------------------ */
/* Cookie 管理                                                          */
/* ------------------------------------------------------------------ */

$('cookieManageBtn').addEventListener('click', async () => {
  $('cookieModal').hidden = false;
  $('cookieMsg').hidden = true;
  $('cookieText').value = '';
  try {
    const c = await api('/api/cookies');
    if (c.exists) toast('已有保存的 Cookie');
  } catch { /* 忽略 */ }
});

$('saveCookieBtn').addEventListener('click', async () => {
  const text = $('cookieText').value;
  try {
    await api('/api/cookies', { method: 'POST', body: text });
    $('cookieModal').hidden = true;
    $('useCookies').disabled = false;
    toast('Cookie 已保存', 'ok');
  } catch (e) {
    $('cookieMsg').textContent = e.message;
    $('cookieMsg').hidden = false;
  }
});

$('deleteCookieBtn').addEventListener('click', async () => {
  await api('/api/cookies', { method: 'DELETE' });
  $('cookieModal').hidden = true;
  $('useCookies').checked = false;
  $('useCookies').disabled = true;
  toast('已删除');
});

document.querySelectorAll('[data-close]').forEach((el) => {
  el.addEventListener('click', () => { $('cookieModal').hidden = true; });
});

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

function connectSSE() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/events');
  state.es = es;

  es.addEventListener('task', (e) => {
    const t = JSON.parse(e.data);
    state.tasks.set(t.id, t);
    renderTask(t);
    if (t.status === 'completed') loadFiles();
  });

  es.addEventListener('progress', (e) => {
    const t = JSON.parse(e.data);
    state.tasks.set(t.id, t);
    renderTask(t);
  });

  es.addEventListener('removed', (e) => {
    const d = JSON.parse(e.data);
    state.tasks.delete(d.id);
    const el = document.getElementById('task-' + d.id);
    if (el) el.remove();
    if (!state.tasks.size) $('taskCard').hidden = true;
  });

  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

/* ------------------------------------------------------------------ */
/* 绑定                                                                */
/* ------------------------------------------------------------------ */

$('parseBtn').addEventListener('click', doParse);
$('downloadBtn').addEventListener('click', startDownload);

$('urlInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doParse();
});
$('urlInput').addEventListener('input', (e) => {
  $('clearUrl').hidden = !e.target.value;
});
$('clearUrl').addEventListener('click', () => {
  $('urlInput').value = '';
  $('clearUrl').hidden = true;
  $('infoCard').hidden = true;
  clearParseError();
  $('urlInput').focus();
});

loadStatus();
loadFiles();
connectSSE();
setInterval(loadStatus, 30000);
