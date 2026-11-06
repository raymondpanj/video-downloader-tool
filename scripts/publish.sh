#!/usr/bin/env bash
# 一键发布到 GitHub
#
# 前提：本机能访问 github.com（SSH 或 HTTPS）
# 用法：./scripts/publish.sh [仓库地址]
#   默认 git@github.com:raymondpanj/video-downloader-tool.git

set -euo pipefail

REPO="${1:-git@github.com:raymondpanj/video-downloader-tool.git}"
BRANCH="main"
cd "$(dirname "$0")/.."

echo "==> 目标仓库: $REPO"

# 1. 检查未提交改动
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "==> 发现未提交改动"
  git add -A
  git commit -m "chore: 更新项目文件"
fi

# 2. 设置 remote
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO"
else
  git remote add origin "$REPO"
fi

# 3. 推送
echo "==> 推送到 $BRANCH"
git push -u origin "$BRANCH"

echo ""
echo "✓ 发布完成"
echo "  https://github.com/raymondpanj/video-downloader-tool"
echo ""
echo "提示：若仓库尚未在 GitHub 创建，请先在网页端新建一个空仓库（不要勾选 README/.gitignore）。"
