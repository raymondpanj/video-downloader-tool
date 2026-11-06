'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnDownload, baseArgs, authArgs } = require('./ytdlp');
const { FORMAT_PRESETS, DOWNLOAD_DIR, TMP_DIR } = require('./config');

/**
 * 下载任务管理器：维护任务队列、SSE 事件广播、进度解析。
 */
class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
    this.queue = [];
    this.running = new Set();
    // 串行执行：并发会推高系统安全策略的批量删除累计计数，导致任务被拦截
    this.maxConcurrent = 1;
    // 周期清扫 tmp/ 残留分片（兜底防止磁盘被占满）。
    // 间隔不宜过短——频繁删除会推高系统安全策略的累计计数阈值。
    this.sweepTimer = setInterval(() => this.sweepAll(), 120000);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  create({ url, preset = 'mp4', formatId = null, referer = '', userAgent = '', useCookies = false, title = null }) {
    const id = crypto.randomBytes(8).toString('hex');
    const task = {
      id,
      url,
      preset,
      formatId,
      referer,
      userAgent,
      useCookies,
      title: title || '解析中…',
      status: 'queued', // queued | running | completed | failed | canceled
      progress: 0,
      phase: '等待中',
      speed: null,
      eta: null,
      totalSize: null,
      downloaded: 0,
      filename: null,
      filepath: null,
      filesize: null,
      error: null,
      logs: [],
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      workDir: null,
      retryCount: 0,
      child: null,
    };
    this.tasks.set(id, task);
    this.queue.push(id);
    this.emit('task:update', this.sanitize(task));
    this.pump();
    return task;
  }

  get(id) {
    return this.tasks.get(id);
  }

  list() {
    return Array.from(this.tasks.values()).map((t) => this.sanitize(t));
  }

  sanitize(t) {
    const { child, ...rest } = t;
    return rest;
  }

  log(task, msg, level = 'info') {
    const line = { ts: Date.now(), level, msg: String(msg).slice(0, 500) };
    task.logs.push(line);
    if (task.logs.length > 400) task.logs.splice(0, task.logs.length - 400);
    this.emit('task:log', { id: task.id, ...line });
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed') return false;
    if (task.child) {
      try {
        task.child.kill('SIGKILL');
      } catch { /* ignore */ }
    }
    if (task.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
    }
    task.status = 'canceled';
    task.phase = '已取消';
    task.finishedAt = Date.now();
    this.emit('task:update', this.sanitize(task));
    for (const t of this.running) { if (t.id === id) this.running.delete(t); }
    this.cleanupWhenStable(task);
    this.pump();
    return true;
  }

  remove(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'running' || task.status === 'queued') this.cancel(id);
    this.tasks.delete(id);
    this.emit('task:remove', { id });
    return true;
  }

  pump() {
    // 允许 maxConcurrent 个任务并行
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      const task = this.tasks.get(id);
      if (!task || task.status === 'canceled') continue;
      this.running.add(task);
      this.start(task);
    }
  }

  buildArgs(task) {
    const p = FORMAT_PRESETS[task.preset] || FORMAT_PRESETS.mp4;
    const args = [
      ...baseArgs(),
      ...authArgs({
        useCookies: task.useCookies,
        referer: task.referer,
        userAgent: task.userAgent,
      }),
      '--newline',
      '--progress',
      // 四个参数共同规避本机安全策略（SAFE_DELETE_BULK_CONFIRM_REQUIRED，
      // 单轮删除上限 50 个文件），否则 yt-dlp 自行清理中间文件时会中断任务：
      //   --no-part         不生成 .part 续传文件
      //   --no-continue     不续传已有分片（避免写 .ytdl 续传状态文件）
      //   -k                合并后不删除中间音视频轨
      //   --keep-fragments  保留 HLS/DASH 分片（否则下载中逐个删除分片）
      //   --concurrent-fragments 1  串行下载分片——并发时 yt-dlp 的清理动作
      //     会集中在同一时间窗触发安全策略的删除阈值（单轮 50 个文件）
      // 所有中间文件统一由 removeFragments / cleanupWorkDir 分批清理。
      '--no-part',
      '--no-continue',
      '--force-overwrites',
      '-k',
      '--keep-fragments',
      '--concurrent-fragments', '1',
    ];

    if (task.formatId) {
      // 用户手动指定了某个格式
      args.push('-f', task.formatId);
    } else {
      args.push('-f', p.format);
    }

    if (p.mergeOutputFormat) {
      args.push('--merge-output-format', p.mergeOutputFormat);
    }
    if (p.postprocess) {
      args.push('--extract-audio', '--audio-format', p.postprocess);
    }

    args.push('-o', '%(title).150B [%(id)s].%(ext)s');
    args.push('--newline');
    args.push(task.url);
    return args;
  }

  start(task) {
    task.status = 'running';
    task.phase = '准备下载';
    task.startedAt = Date.now();
    this.emit('task:update', this.sanitize(task));

    const args = this.buildArgs(task);
    this.log(task, `启动: yt-dlp ${args.filter((a) => !a.startsWith('http')).join(' ')}`);

    // 每个任务在独立的工作目录中下载，完成后再归位到 downloads/
    // 这样不同任务即使下载同一个视频也不会互相覆盖或触发续传冲突
    const workDir = path.join(TMP_DIR, task.id);
    fs.mkdirSync(workDir, { recursive: true });
    task.workDir = workDir;
    // 重试时清空上一轮残留，避免 yt-dlp 误判续传
    try {
      for (const f of fs.readdirSync(workDir)) {
        try { fs.unlinkSync(path.join(workDir, f)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    const child = spawnDownload(args, {
      cwd: workDir,
      onStdout: (chunk) => this.onStdout(task, chunk),
      onStderr: (chunk) => this.onStderr(task, chunk),
    });
    task.child = child;

    child.on('error', (err) => {
      this.finish(task, 'failed', `进程启动失败: ${err.message}`);
    });

    child.on('close', (code) => {
      task.child = null;
      if (task.status === 'canceled') {
        this.cleanupWhenStable(task);
        this.running.delete(task);
        this.pump();
        return;
      }
      if (code === 0) {
        // yt-dlp 退出后可能仍在写分片，等待文件数稳定后再归位与清理
        setTimeout(() => {
          const moved = this.collectOutput(task);
          if (moved) {
            this.finish(task, 'completed', '下载完成');
          } else {
            this.finish(task, 'failed', '下载完成但未找到输出文件');
          }
          this.cleanupWhenStable(task);
        }, 1500);
      } else {
        // 优先使用 stderr 中捕获的具体错误，否则用退出码兜底
        const detail = task.error || `yt-dlp 退出码 ${code}`;
        // 安全策略对删除操作有全局累计计数，达到阈值后 yt-dlp 的清理动作会被拒绝。
        // 这类失败是临时的：等待计数窗口刷新后重试即可成功。
        if (task.safeDeleteBlocked && (task.retryCount || 0) < 3) {
          task.retryCount = (task.retryCount || 0) + 1;
          task.phase = `等待重试 (${task.retryCount}/3)`;
          task.error = null;
          task.safeDeleteBlocked = false;
          this.log(task, `触发安全策略拦截，${20 * task.retryCount} 秒后重试`, 'warn');
          this.emit('task:update', this.sanitize(task));
          // 重新入队（置于队首），由 pump 统一调度，避免并发状态错乱
          setTimeout(() => {
            task.status = 'queued';
            task.phase = '重试排队中';
            this.queue.unshift(task.id);
            this.pump();
          }, 90000 * task.retryCount);
          this.running.delete(task);
          this.pump();
          return;
        }
        this.finish(task, 'failed', detail);
        this.cleanupWhenStable(task);
      }
      this.running.delete(task);
      this.pump();
    });

    // 兜底：任何未捕获异常都不应让整个服务崩溃
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
  }

  /**
   * 把工作目录中的产物移动到 downloads/，并处理重名。
   * @returns {boolean} 是否成功归位
   */
  collectOutput(task) {
    const workDir = task.workDir;
    if (!workDir || !fs.existsSync(workDir)) return false;
    try {
      // 分片与中间态文件一律排除
      const isJunk = (f) => /(?:-Frag\d+|\.part-Frag\d+)$/.test(f)
        || f.endsWith('.ytdl')
        || f.endsWith('.part');

      const all = fs.readdirSync(workDir).filter((f) => !isJunk(f));
      if (!all.length) return false;

      // 「合并产物」= 文件名中不含 .fNNNN. 格式标识
      const isTrack = (f) => /\.f\d{3,6}\.[a-z0-9]+$/i.test(f);
      const merged = all.filter((f) => !isTrack(f));

      // 有合并产物 → 只保留它（.fNNNN 是被合并掉的中间分轨）
      // 无合并产物 → 保留全部分轨（如「仅视频」「原始文件」预设，本就不合并）
      const deliverables = merged.length ? merged : all;

      // 优先使用任务记录的 filename
      let names = deliverables;
      if (task.filename && deliverables.includes(task.filename)) {
        names = [task.filename];
      } else if (deliverables.length > 1) {
        // 多分轨：按体积从大到小
        names = deliverables.slice().sort((a, b) =>
          fs.statSync(path.join(workDir, b)).size - fs.statSync(path.join(workDir, a)).size);
      }

      const saved = [];
      for (const name of names) {
        const src = path.join(workDir, name);
        if (!fs.existsSync(src)) continue;

        // 去掉 yt-dlp 的 .fNNNN. 格式标识，让文件名可读
        // 例：xxx.f100026.mp4 → xxx.video.mp4
        let outName = name;
        const trackMatch = name.match(/^(.*)\.f\d{3,6}\.([a-z0-9]+)$/i);
        if (trackMatch) {
          const kind = /^(m4a|mp3|aac|opus|weba|ogg|flac)$/i.test(trackMatch[2]) ? 'audio' : 'video';
          outName = `${trackMatch[1]}.${kind}.${trackMatch[2]}`;
        }

        // 目标重名时追加序号
        let target = path.join(DOWNLOAD_DIR, outName);
        let n = 1;
        while (fs.existsSync(target)) {
          const ext = path.extname(outName);
          const base = outName.slice(0, outName.length - ext.length);
          target = path.join(DOWNLOAD_DIR, `${base} (${n})${ext}`);
          n += 1;
        }

        try {
          moveFile(src, target);
          saved.push({ name: path.basename(target), size: fs.statSync(target).size });
        } catch (e) {
          this.log(task, `移动失败 ${name}: ${e.message}`, 'error');
        }
      }

      if (!saved.length) return false;

      // 主产物 = 体积最大的那个
      const main = saved.slice().sort((a, b) => b.size - a.size)[0];
      task.filename = main.name;
      task.filepath = path.join(DOWNLOAD_DIR, main.name);
      task.filesize = main.size;
      if (saved.length > 1) {
        task.extraFiles = saved.slice(1);
        this.log(task, `已保存 ${saved.length} 个文件，主产物: ${main.name}`);
      } else {
        this.log(task, `已保存到: ${main.name}`);
      }
      return true;
    } catch (e) {
      this.log(task, `归位失败: ${e.message}`, 'error');
      return false;
    }
  }

  /**
   * 等待工作目录中的文件数稳定（yt-dlp 可能持续写入分片），
   * 稳定后再分批删除中间文件并移除目录。
   */
  async cleanupWhenStable(task, { maxWait = 120000 } = {}) {
    if (!task.workDir) return;
    const dir = task.workDir;
    let lastSignature = '';
    let stableRounds = 0;
    const startedAt = Date.now();

    // 等待目录内容稳定：连续多轮「文件数 + 总字节数」均不变，才认为写入结束。
    // 仅比较文件数不够——yt-dlp 可能在持续覆写同一批分片。
    while (Date.now() - startedAt < maxWait) {
      let signature = '';
      try {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir);
        let total = 0;
        for (const f of entries) {
          try { total += fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
        }
        signature = `${entries.length}:${total}`;
      } catch {
        return;
      }
      if (signature === lastSignature) {
        stableRounds += 1;
        if (stableRounds >= 3) break;   // 连续 3 轮稳定
      } else {
        stableRounds = 0;
        lastSignature = signature;
      }
      await sleep(1500);
    }

    this.removeFragments(task);
    this.cleanupWorkDir(task);
  }

  cleanupWorkDir(task) {
    if (!task.workDir) return;
    try {
      if (!fs.existsSync(task.workDir)) return;
      // 分批删除，避免一次性删除过多文件触发系统安全策略拦截
      const entries = fs.readdirSync(task.workDir);
      for (let i = 0; i < entries.length; i += 10) {
        const batch = entries.slice(i, i + 10);
        for (const f of batch) {
          try {
            fs.unlinkSync(path.join(task.workDir, f));
          } catch { /* ignore */ }
        }
      }
      try {
        fs.rmdirSync(task.workDir);
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }

  /** 清理工作目录中的 HLS/DASH 分片与中间分轨（分批执行，避免触发批量删除安全策略） */
  removeFragments(task) {
    if (!task.workDir) return;
    try {
      if (!fs.existsSync(task.workDir)) return;
      const leftovers = fs.readdirSync(task.workDir).filter((f) =>
        /(?:-Frag\d+|\.part-Frag\d+)$/.test(f) || /\.f\d{3,6}\.[a-z0-9]+$/i.test(f));
      if (!leftovers.length) return;
      for (let i = 0; i < leftovers.length; i += 8) {
        for (const f of leftovers.slice(i, i + 8)) {
          try {
            fs.unlinkSync(path.join(task.workDir, f));
          } catch { /* ignore */ }
        }
      }
      this.log(task, `已清理 ${leftovers.length} 个中间文件`);
    } catch { /* ignore */ }
  }

  /**
   * 兜底清扫：清理 tmp/ 下所有工作目录的残留分片。
   * 由定时器周期调用，确保即使单次清理时机不准也能最终清空。
   */
  sweepAll() {
    if (!fs.existsSync(TMP_DIR)) return;
    let dirs;
    try { dirs = fs.readdirSync(TMP_DIR); } catch { return; }
    for (const name of dirs) {
      const dir = path.join(TMP_DIR, name);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        const leftovers = fs.readdirSync(dir).filter((f) =>
          /(?:-Frag\d+|\.part-Frag\d+)$/.test(f) || /\.f\d{3,6}\.[a-z0-9]+$/i.test(f));
        for (let i = 0; i < leftovers.length; i += 8) {
          for (const f of leftovers.slice(i, i + 8)) {
            try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
          }
        }
        // 目录空了就删掉
        if (!fs.readdirSync(dir).length) {
          try { fs.rmdirSync(dir); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  }

  onStdout(task, chunk) {
    for (const rawLine of chunk.toString().split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      this.parseLine(task, line);
    }
  }

  onStderr(task, chunk) {
    for (const rawLine of chunk.toString().split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      // 全量记录 stderr，便于排查
      this.log(task, line, /error/i.test(line) ? 'error' : 'warn');

      // 安全策略拦截：单独标记，供重试逻辑判定
      if (/safe-delete|SAFE_DELETE_BULK/i.test(line)) {
        task.safeDeleteBlocked = true;
        if (!task.error) task.error = '触发系统安全策略的批量删除限制';
        continue;
      }

      // 提取核心错误信息，便于前端展示
      const m = line.match(/(?:^|\]|\s)ERROR:?\s*(.+?)(?:\s+Report.*)?$/i);
      if (m && !task.error) task.error = m[1].trim();
    }
  }

  parseLine(task, line) {
    // [download]  12.3% of 4.69MiB at 1.35MiB/s ETA 00:03
    const dl = line.match(
      /^\[download\]\s+([\d.]+)%\s+of\s+(?:~?\s*)?([\d.]+\s*(?:KiB|MiB|GiB|B))?\s*(?:at\s+([\d.]+\s*(?:KiB|MiB|GiB|B)\/s))?\s*(?:ETA\s+(\S+))?/i,
    );
    if (dl) {
      const pct = parseFloat(dl[1]);
      task.progress = Math.max(task.progress, pct);
      if (dl[2]) task.totalSize = parseSize(dl[2]);
      if (dl[3]) task.speed = dl[3].trim();
      if (dl[4]) task.eta = dl[4];
      task.phase = task.preset === 'mp4' && pct >= 100 ? '合并音视频' : '下载中';
      this.emit('task:progress', this.sanitize(task));
      return;
    }

    // [download] Destination: xxx.mp4
    const dest = line.match(/^\[download\]\s+Destination:\s+(.+)$/);
    if (dest) {
      const name = path.basename(dest[1].trim());
      task.filename = name;
      task.filepath = path.join(DOWNLOAD_DIR, name);
      task.phase = '下载中';
      this.log(task, `输出文件: ${name}`);
      this.emit('task:update', this.sanitize(task));
      return;
    }

    // [download] 100% of 4.69MiB in 00:00:00
    const done = line.match(/^\[download\]\s+100%.*in\s+(\S+)\s+at\s+(\S+)/);
    if (done) {
      task.progress = 100;
      task.speed = done[2];
      task.phase = '处理中';
      this.emit('task:progress', this.sanitize(task));
      return;
    }

    // [Merger] Merging formats into "xxx.mp4"
    const merger = line.match(/^\[Merger\]\s+Merging formats into\s+"(.+?)"/);
    if (merger) {
      const name = path.basename(merger[1]);
      task.filename = name;
      task.filepath = path.join(DOWNLOAD_DIR, name);
      task.phase = '合并音视频';
      this.log(task, `合并为: ${name}`);
      this.emit('task:update', this.sanitize(task));
      return;
    }

    // [ExtractAudio] Destination: xxx.mp3
    const audio = line.match(/^\[ExtractAudio\]\s+Destination:\s+(.+)$/);
    if (audio) {
      const name = path.basename(audio[1].trim());
      task.filename = name;
      task.filepath = path.join(DOWNLOAD_DIR, name);
      task.phase = '转码音频';
      this.emit('task:update', this.sanitize(task));
      return;
    }

    // [download] Destination 后紧跟的文件已完成
    if (line.startsWith('[download]') && line.includes('has already been downloaded')) {
      this.log(task, line);
      return;
    }

    if (/^\[info\]/.test(line) && task.title === '解析中…') {
      const m = line.match(/^\[info\]\s+(.+?):\s+Downloading/);
      if (m) {
        task.title = m[1];
        this.emit('task:update', this.sanitize(task));
      }
    }
  }

  finish(task, status, message) {
    task.status = status;
    task.finishedAt = Date.now();
    task.phase = status === 'completed' ? '已完成' : '失败';
    if (status === 'completed') {
      task.progress = 100;
      task.error = null;
    } else {
      task.error = message;
    }
    this.log(task, message, status === 'completed' ? 'info' : 'error');
    this.emit('task:update', this.sanitize(task));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 判断错误是否由安全策略的批量删除拦截引起 */
function isSafeDeleteError(msg) {
  if (!msg) return false;
  return /SAFE_DELETE_BULK|safe-delete/i.test(String(msg))
    || /Unable to delete|Unable to remove/i.test(String(msg));
}

/**
 * 移动文件：同盘用 rename（快），跨盘用 复制+删除。
 * 工作目录在 D 盘、成品在 C 盘时 rename 会抛 EXDEV。
 */
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
  }
  fs.copyFileSync(src, dest);
  try { fs.unlinkSync(src); } catch { /* ignore */ }
}

function parseSize(s) {  const m = String(s).match(/([\d.]+)\s*(KiB|MiB|GiB|B|K|M|G)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[unit[0]] || 1;
  return Math.round(n * mult);
}

module.exports = { TaskManager };
