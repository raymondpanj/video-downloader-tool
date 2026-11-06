# 在线视频下载工具

本地运行的网页版视频下载工具。基于 **yt-dlp + FFmpeg** 内核，支持 B站 / YouTube / 抖音 / 西瓜等主流站点，以及各种 m3u8 / mp4 直链。

所有下载与转码都在你自己的机器上完成，不上传任何数据。

![Node](https://img.shields.io/badge/Node-%E2%89%A518-green) ![License](https://img.shields.io/badge/license-MIT-blue)

## 特性

- **网页界面** —— 粘贴链接即可，无需命令行
- **四种输出格式** —— MP4 合并 / 仅视频 / 仅音频 MP3 / 原始文件
- **实时进度** —— 速度、剩余时间、当前阶段（下载中 → 合并音视频）
- **格式手动指定** —— 展开可看全部可用格式（分辨率、大小、编码），可锁定单个格式
- **会员/私有内容** —— 支持导入 cookies.txt
- **自定义请求头** —— 可设置 Referer / User-Agent，应对来源校验
- **在线预览** —— 下载完直接播放，支持拖动定位
- **跨平台** —— Windows / macOS / Linux

## 快速开始

```bash
git clone https://github.com/raymondpanj/video-downloader-tool.git
cd video-downloader-tool

npm install          # 安装 Node 依赖
npm run setup        # 自动安装 yt-dlp 与 FFmpeg
npm start
```

浏览器打开 <http://127.0.0.1:8899> 即可。

> **Windows 用户若没有 Python**：先安装 [Python 3.8+](https://www.python.org/downloads/) 并勾选「Add Python to PATH」。

## 使用流程

1. **粘贴链接** → 点「解析」，显示标题、时长、UP主、可用格式
2. **选择输出格式**：

   | 预设 | 说明 |
   |---|---|
   | MP4（合并音视频） | 最佳画质，音视频合并为单文件，兼容性最好 |
   | 仅视频（不合并） | 保留原始视频轨 |
   | 仅音频（MP3） | 提取为 MP3 |
   | 原始文件（不处理） | 直接保存源文件，不转码 |

3. **开始下载** → 实时进度条，完成后可直接预览或下载

高级选项里可设置 **Referer**、**User-Agent**，以及导入 **cookies.txt**。

## 关于 Cookie

部分站点（抖音、会员视频）必须带登录态才能访问，工具会提示 `Fresh cookies are needed`。

「管理 Cookie」里粘贴 **Netscape 格式**的 cookies.txt 内容。浏览器扩展
[Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkiiahkgnmfcioegckm) 可直接导出。

Cookie 文件保存在 `cookies/cookies.txt`（已加入 `.gitignore`，不会提交到仓库）。

## 依赖安装说明

`npm run setup` 会自动完成两件事，全程走国内镜像，不依赖 GitHub：

| 依赖 | 来源 | 说明 |
|---|---|---|
| yt-dlp | PyPI 镜像（腾讯云 / 阿里云 / 官方） | 以 Python 包形式安装，通过 `python -m yt_dlp` 调用 |
| FFmpeg / FFprobe | conda-forge 镜像（清华 / 官方） | 经 micromamba 安装，依赖自动解析 |

其他命令：

```bash
npm run setup -- --cn      # 强制走国内镜像
npm run check              # 只检查依赖状态，不安装
```

如果你已有 FFmpeg，也可以直接放进 `bin/` 目录，或用环境变量 `VD_BIN_DIR` 指向它所在位置。

## 配置项

通过环境变量调整：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8899` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址（改为 `0.0.0.0` 可局域网访问） |
| `VD_BIN_DIR` | `./bin` | FFmpeg / FFprobe 所在目录 |
| `VD_DOWNLOAD_DIR` | `./downloads` | 下载成品目录 |
| `VD_TMP_DIR` | 自动（优先 D 盘） | 临时工作目录 |
| `VD_PYTHON` | `python` | Python 解释器 |

## 项目结构

```
video-downloader-tool/
├── server.js              # Express 服务 + API + SSE
├── scripts/setup.js       # 依赖自举安装脚本
├── src/
│   ├── config.js          # 路径与输出预设
│   ├── ytdlp.js           # yt-dlp 调用封装
│   └── tasks.js           # 任务队列 / 进度解析 / 文件归位
├── public/                # 前端页面（原生 JS，无构建步骤）
├── bin/                   # FFmpeg（由 setup 脚本安装，不入库）
├── downloads/             # 下载成品
└── cookies/               # cookies.txt
```

**每个任务在独立临时目录下载**，完成后再归位到 `downloads/`。这样同一视频重复下载、不同格式并行下载都不会互相覆盖；重名文件自动追加序号。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 环境状态与可用预设 |
| POST | `/api/probe` | 解析链接，返回元信息与格式列表 |
| POST | `/api/download` | 创建下载任务 |
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| DELETE | `/api/tasks/:id` | 移除任务记录 |
| GET | `/api/events` | SSE 实时事件流 |
| GET/POST/DELETE | `/api/cookies` | Cookie 管理 |
| GET | `/api/files` | 已下载文件列表 |
| GET | `/api/files/:name` | 下载文件 |
| GET | `/api/preview/:name` | 在线预览（支持 Range 拖动） |
| POST | `/api/open-folder` | 打开下载目录 |

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| `Fresh cookies are needed` | 站点需登录，导入 cookies.txt |
| `Tunnel connection failed: 502` | 网络代理问题，检查代理设置或换网络 |
| `Requested format is not available` | 该站点无分离音视频轨，试试其他输出预设 |
| `无法下载 API page` | 站点有反爬或需要登录，换用 Cookie |
| 磁盘空间不足 | 临时分片体积可达成品的数倍，注意预留空间 |
| 任务提示「触发系统安全策略的批量删除限制」 | 系统的批量删除保护（单轮上限 50 文件），工具会自动等待后重试 |

## 安全与合规

- 仅供下载**你有权获取**的内容使用，请遵守版权法规与各站点的服务条款。
- 工具仅在本地运行，不会主动绕过 DRM 或付费墙。
- 请勿用于批量抓取、转载侵权内容或侵犯他人隐私。

## License

[MIT](LICENSE)
