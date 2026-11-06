'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DOWNLOAD_DIR = process.env.VD_DOWNLOAD_DIR || path.join(ROOT, 'downloads');
const COOKIE_DIR = path.join(ROOT, 'cookies');
const BIN_DIR = process.env.VD_BIN_DIR || path.join(ROOT, 'bin');

// 临时工作目录：下载分片体积可达成品的数倍，优先放 D 盘等大空间盘
function pickTmpDir() {
  if (process.env.VD_TMP_DIR) return process.env.VD_TMP_DIR;
  for (const d of ['D:\\', 'E:\\', 'F:\\']) {
    try {
      if (fs.existsSync(d)) return path.join(d, 'vd-tmp');
    } catch { /* ignore */ }
  }
  return path.join(ROOT, 'tmp');
}
const TMP_DIR = pickTmpDir();

for (const dir of [DOWNLOAD_DIR, COOKIE_DIR, BIN_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// 清理上次运行遗留的临时工作目录（分批删除，避免触发批量删除安全策略）
try {
  for (const name of fs.readdirSync(TMP_DIR)) {
    const dir = path.join(TMP_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = fs.readdirSync(dir);
    for (let i = 0; i < files.length; i += 10) {
      for (const f of files.slice(i, i + 10)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
    try { fs.rmdirSync(dir); } catch { /* ignore */ }
  }
} catch { /* ignore */ }

// 清理 downloads/ 中遗留的中间分轨（fXXXXX.mp4 等，合并失败的残留）
try {
  for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
    if (/\.f\d{3,6}\.[a-z0-9]+$/i.test(f)) {
      try { fs.unlinkSync(path.join(DOWNLOAD_DIR, f)); } catch { /* ignore */ }
    }
  }
} catch { /* ignore */ }

// yt-dlp 通过 pip 安装的 Python 包调用（不走 GitHub 下载二进制）
const PYTHON = process.env.VD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const YT_DLP_MODULE = 'yt_dlp';

const FFMPEG_DIR = BIN_DIR;

// yt-dlp 专用 UA，模拟真实浏览器，避免部分站点拒绝默认 UA
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 可选输出格式
const FORMAT_PRESETS = {
  // 合并音视频为 mp4
  mp4: {
    label: 'MP4（合并音视频）',
    format: 'bv*+ba/b',
    mergeOutputFormat: 'mp4',
    ext: 'mp4',
  },
  // 仅视频轨（不合并）；bv* 找不到时回退到 b
  video: {
    label: '仅视频（不合并）',
    format: 'bv*/b',
    mergeOutputFormat: null,
    ext: null, // 由 yt-dlp 决定
  },
  // 仅音频，转 mp3
  audio: {
    label: '仅音频（MP3）',
    format: 'ba/b',
    postprocess: 'mp3',
    ext: 'mp3',
  },
  // 保持原始容器，不做合并/转码
  // 用 bv*+ba/b 而非 b：部分站点（如B站）只有分离的音视频轨，
  // 纯 b 会因「Requested format is not available」失败
  raw: {
    label: '原始文件（不处理）',
    format: 'bv*+ba/b',
    mergeOutputFormat: null,
    ext: null,
  },
};

module.exports = {
  ROOT,
  DOWNLOAD_DIR,
  COOKIE_DIR,
  BIN_DIR,
  TMP_DIR,
  PYTHON,
  YT_DLP_MODULE,
  FFMPEG_DIR,
  DEFAULT_UA,
  FORMAT_PRESETS,
};
