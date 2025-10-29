#!/usr/bin/env sh
set -e

# 固定安装目录（Termux 下通常为 $HOME）
INSTALL_PARENT="${HOME}"
WORK_DIR="${INSTALL_PARENT}/control-panel-main"

# 安装基础依赖（Termux），在非 Termux 环境下跳过
if command -v pkg >/dev/null 2>&1; then
  pkg install -y nodejs mosquitto unzip
fi

# 下载文件，优先使用 wget，缺失则使用 curl
ZIP_URL="https://www.ezsapi.top/control-panel-stable.zip"
ZIP_FILE="${INSTALL_PARENT}/control-panel-stable.zip"

if command -v wget >/dev/null 2>&1; then
  wget -O "$ZIP_FILE" "$ZIP_URL"
elif command -v curl >/dev/null 2>&1; then
  curl -L -o "$ZIP_FILE" "$ZIP_URL"
else
  echo "未找到 wget 或 curl，请安装其中之一后重试." >&2
  exit 1
fi

# 解压到固定目录
mkdir -p "$INSTALL_PARENT"
unzip -o "$ZIP_FILE" -d "$INSTALL_PARENT"

# 兼容可能出现的不同顶级目录名（从 zip 中解析出第一层目录）
if [ ! -d "$WORK_DIR" ]; then
  TOP_DIR="$(unzip -Z -1 "$ZIP_FILE" | head -1 | cut -d/ -f1)"
  if [ -n "$TOP_DIR" ] && [ -d "${INSTALL_PARENT}/${TOP_DIR}" ]; then
    WORK_DIR="${INSTALL_PARENT}/${TOP_DIR}"
  fi
fi

# 进入目录并安装依赖
cd "$WORK_DIR"
if [ -f package.json ]; then
  npm install
fi

# 安装 backend 依赖
cd "$WORK_DIR"
if [ -d backend ]; then
  cd backend
  npm install
  cd ..
fi

# 安装 frontend 依赖
cd "$WORK_DIR"
if [ -d frontend ]; then
  cd frontend
  npm install
  cd ..
fi

# 启动（必须在顶级目录执行）
npm run dev:all