#!/usr/bin/env node
'use strict';

/**
 * 依赖自举脚本：安装 yt-dlp（Python 包）与 FFmpeg/FFprobe。
 *
 * 设计原则：不依赖 GitHub（很多网络环境访问不到），全部走
 *   - PyPI 镜像（腾讯云 / 阿里云 / 官方源自动回退）
 *   - conda-forge 镜像（清华 / 官方源自动回退）
 *
 * 用法：
 *   node scripts/setup.js            # 自动选择可用源
 *   node scripts/setup.js --mirror cn  # 强制使用国内镜像
 *   node scripts/setup.js --check    # 只检查依赖状态
 */

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const IS_WIN = process.platform === 'win32';

const args = process.argv.slice(2);
const FORCE_CN = args.includes('--cn') || args.includes('--mirror');
const CHECK_ONLY = args.includes('--check');

const PYPI_MIRRORS = [
  'https://mirrors.cloud.tencent.com/pypi/simple/',
  'https://mirrors.aliyun.com/pypi/simple/',
  'https://pypi.org/simple/',
];

const CONDA_MIRRORS = [
  'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge',
  'https://mirrors.cloud.tencent.com/anaconda/cloud/conda-forge',
  'https://conda.anaconda.org/conda-forge',
];

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function log(msg) { console.log(msg); }
function ok(msg) { console.log(`${c.green('✓')} ${msg}`); }
function warn(msg) { console.log(`${c.yellow('!')} ${msg}`); }
function err(msg) { console.log(`${c.red('✗')} ${msg}`); }
function info(msg) { console.log(c.dim(`  ${msg}`)); }

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function which(cmd) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    stdio: opts.quiet ? 'pipe' : 'inherit',
    shell: false,
    ...opts,
  });
}

function httpOk(url, timeout = 8000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/* ------------------------------------------------------------------ */
/* yt-dlp                                                              */
/* ------------------------------------------------------------------ */

function pythonCandidates() {
  const list = [];
  if (process.env.VD_PYTHON) list.push(process.env.VD_PYTHON);
  if (IS_WIN) list.push('python', 'py', 'python3');
  else list.push('python3', 'python');
  return [...new Set(list)];
}

function findPython() {
  for (const p of pythonCandidates()) {
    const r = run(p, ['-c', 'import sys;print(sys.version_info[0])'], { quiet: true });
    if (r.status === 0) {
      const major = parseInt(String(r.stdout).trim(), 10);
      if (major >= 3 && major < 4) return p;
    }
  }
  return null;
}

function hasYtDlp(python) {
  const r = run(python, ['-m', 'yt_dlp', '--version'], { quiet: true });
  return r.status === 0 && /^\d+\.\d+/.test(String(r.stdout).trim());
}

async function installYtDlp(python) {
  const mirrors = FORCE_CN ? PYPI_MIRRORS : [...PYPI_MIRRORS, 'https://pypi.org/simple/'];
  for (const m of mirrors) {
    info(`尝试源 ${m}`);
    const r = run(python, ['-m', 'pip', 'install', '-U', 'yt-dlp', '-i', m, '--trusted-host', new URL(m).host], { quiet: true });
    if (r.status === 0 || hasYtDlp(python)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* FFmpeg                                                              */
/* ------------------------------------------------------------------ */

function ffmpegExe() { return path.join(BIN_DIR, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'); }
function ffprobeExe() { return path.join(BIN_DIR, IS_WIN ? 'ffprobe.exe' : 'ffprobe'); }

function hasFfmpeg() {
  const exe = ffmpegExe();
  if (!fs.existsSync(exe)) return false;
  const r = run(exe, ['-version'], { quiet: true });
  return r.status === 0;
}

/** 尝试用系统自带的 ffmpeg（PATH 中） */
function systemFfmpeg() {
  const p = which(IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');
  if (!p) return null;
  const r = run(p, ['-version'], { quiet: true });
  return r.status === 0 ? p : null;
}

/**
 * 通过 micromamba 装 ffmpeg —— 依赖自动解析，是最可靠的方式。
 * 直接解压 conda 包会缺 zlib/openssl 等 DLL，务必用包管理器。
 */
async function installViaMicromamba() {
  const workDir = path.join(ROOT, '.setup-tmp');
  fs.mkdirSync(workDir, { recursive: true });

  // 1. 下载 micromamba
  const mmExe = path.join(workDir, IS_WIN ? 'micromamba.exe' : 'micromamba');
  if (!fs.existsSync(mmExe)) {
    // micromamba 的各分发点统一提供 .tar.bz2 归档（含 Library/bin/micromamba）
    const urls = IS_WIN
      ? [
        'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/win-64/micromamba-2.10.0-0.tar.bz2',
        'https://micro.mamba.pm/api/micromamba/win-64/latest',
        'https://mirrors.cloud.tencent.com/anaconda/cloud/conda-forge/win-64/micromamba-2.10.0-0.tar.bz2',
      ]
      : [
        'https://micro.mamba.pm/api/micromamba/linux-64/latest',
        'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/linux-64/micromamba-2.10.0-0.tar.bz2',
      ];

    for (const u of urls) {
      info(`下载 micromamba: ${u}`);
      const tmpFile = path.join(workDir, 'mm-archive.bin');
      const code = await downloadFile(u, tmpFile);
      if (code !== 0) { warn('下载失败，尝试下一个源'); continue; }

      // 校验是 bzip2 归档（BZh9 魔数）
      const head = readHead(tmpFile, 4);
      if (!head.startsWith('425A68')) {
        warn('下载内容不是 tar.bz2 归档，尝试下一个源');
        continue;
      }

      if (!extractTarBz2(tmpFile, workDir)) { warn('解压失败，尝试下一个源'); continue; }
      const found = findFile(workDir, IS_WIN ? 'micromamba.exe' : 'micromamba');
      if (!found) { warn('归档内未找到 micromamba，尝试下一个源'); continue; }
      fs.copyFileSync(found, mmExe);
      break;
    }

    if (!fs.existsSync(mmExe)) {
      err('micromamba 下载失败');
      return false;
    }
  }
  fs.chmodSync(mmExe, 0o755);

  // 2. 创建环境
  const envPrefix = path.join(ROOT, '.ffmpeg-env');
  const mirrors = FORCE_CN ? CONDA_MIRRORS : [...CONDA_MIRRORS, 'https://conda.anaconda.org/conda-forge'];
  let installed = false;
  for (const m of mirrors) {
    info(`conda 源 ${m}`);
    const r = run(mmExe, [
      'create', '-y', '-p', envPrefix, '-c', m, 'ffmpeg',
    ], {
      quiet: true,
      env: { ...process.env, MAMBA_ROOT_PREFIX: path.join(workDir, 'mamba-root') },
    });
    if (r.status === 0) {
      const srcDir = path.join(envPrefix, IS_WIN ? 'Library\\bin' : 'bin');
      if (fs.existsSync(srcDir)) {
        copyDir(srcDir, BIN_DIR);
        installed = true;
        break;
      }
    }
  }
  if (!installed) {
    err('conda 安装 ffmpeg 失败');
    return false;
  }
  ok('FFmpeg 已安装到 bin/');

  // 3. 清理临时目录（conda 环境与包缓存合计常超 1GB，装完即回收）
  info('清理安装临时文件…');
  removeTree(envPrefix);
  removeTree(path.join(workDir, 'mamba-root'));
  removeTree(workDir);
  return true;
}

/** 递归删除目录（分批删文件，规避系统批量删除阈值） */
function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    const files = ents.filter((e) => !e.isDirectory());
    for (let i = 0; i < files.length; i += 8) {
      for (const f of files.slice(i, i + 8)) {
        try { fs.unlinkSync(path.join(d, f.name)); } catch { /* ignore */ }
      }
    }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
    try { fs.rmdirSync(d); } catch { /* ignore */ }
  };
  walk(dir);
}

/* ------------------------------------------------------------------ */
/* 下载与解压工具                                                      */
/* ------------------------------------------------------------------ */

function downloadFile(url, dest) {
  return new Promise((resolve) => {
    const doReq = (u, redirects = 0) => {
      if (redirects > 5) return resolve(1);
      https.get(u, { timeout: 120000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          return doReq(next, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(1); }
        const tmp = `${dest}.part`;
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', () => {
          out.close();
          try { fs.renameSync(tmp, dest); } catch { /* ignore */ }
          resolve(0);
        });
        out.on('error', () => resolve(1));
      }).on('error', () => resolve(1)).on('timeout', function onTimeout() {
        this.destroy();
        resolve(1);
      });
    };
    doReq(url);
  });
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

/** 读取文件头部并以十六进制字符串返回 */
function readHead(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.toString('hex').toUpperCase();
  } catch {
    return '';
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 解压 .tar.bz2 —— 用 Node 内置 zlib 自行解析 tar，
 * 不依赖外部 tar 命令（Windows 上的 GNU tar / bsdtar 对含盘符的路径
 * 处理不一致，会报 "Cannot connect to C: resolve failed"）。
 */
/**
 * 解压 .tar.bz2。
 *
 * Node 的 zlib 不支持 bzip2，而 Windows 上的 GNU tar / bsdtar 对含盘符的
 * 路径处理不一致（报 "Cannot connect to C: resolve failed"）。
 * Python 已是本工具的必需依赖，其标准库自带 bzip2 + tarfile，
 * 因此统一交给 Python 解压，最稳。
 */
function extractTarBz2(archive, destDir) {
  const python = findPython();
  if (python) {
    const script = `
import sys, tarfile
with tarfile.open(sys.argv[1], 'r:bz2') as tf:
    tf.extractall(sys.argv[2])
`;
    const r = spawnSync(python, ['-c', script, archive, destDir], { encoding: 'utf8' });
    if (r.status === 0) return true;
    warn(`Python 解压失败: ${(r.stderr || '').trim().split('\n').pop()}`);
  }

  // 退路：系统 tar（用相对路径规避盘符冒号问题）
  const rel = path.relative(process.cwd(), archive);
  const r2 = spawnSync('tar', ['-xjf', rel, '-C', destDir], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  return r2.status === 0;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  log('');
  log(c.bold('  在线视频下载工具 — 依赖安装'));
  log(c.dim('  ────────────────────────────────────────'));
  log('');

  fs.mkdirSync(BIN_DIR, { recursive: true });

  // --- yt-dlp ---
  let python = findPython();
  if (!python) {
    err('未找到 Python 3，请先安装 Python 3.8+ 并加入 PATH');
    process.exit(1);
  }
  info(`Python: ${python}`);

  if (hasYtDlp(python)) {
    const v = run(python, ['-m', 'yt_dlp', '--version'], { quiet: true }).stdout.trim();
    ok(`yt-dlp 已安装 (v${v})`);
  } else if (CHECK_ONLY) {
    warn('yt-dlp 未安装（运行 node scripts/setup.js 安装）');
  } else {
    log('安装 yt-dlp…');
    if (await installYtDlp(python)) {
      const v = run(python, ['-m', 'yt_dlp', '--version'], { quiet: true }).stdout.trim();
      ok(`yt-dlp 安装完成 (v${v})`);
    } else {
      err('yt-dlp 安装失败，请手动执行: pip install -U yt-dlp');
      process.exit(1);
    }
  }

  // --- FFmpeg ---
  if (hasFfmpeg()) {
    const v = run(ffmpegExe(), ['-version'], { quiet: true }).stdout.split('\n')[0];
    ok(`FFmpeg 已就绪 (${v.replace('ffmpeg version ', '').split(' ')[0]})`);
  } else {
    const sys = systemFfmpeg();
    if (sys) {
      info(`检测到系统 FFmpeg: ${sys}`);
      info('如需使用项目内置版本，请重新运行安装脚本');
    } else if (CHECK_ONLY) {
      warn('FFmpeg 未安装（运行 node scripts/setup.js 安装）');
    } else {
      log('安装 FFmpeg（通过 conda-forge，依赖自动解析）…');
      if (!(await installViaMicromamba())) {
        err('FFmpeg 安装失败');
        info('可手动安装后把 ffmpeg / ffprobe 放入 bin/ 目录');
        info('或设置环境变量 VD_BIN_DIR 指向已有 ffmpeg 所在目录');
        process.exit(1);
      }
    }
  }

  log('');
  log(c.dim('  ────────────────────────────────────────'));
  ok('依赖就绪，运行 npm start 启动');
  log('');
}

main().catch((e) => {
  err(e.message);
  process.exit(1);
});
