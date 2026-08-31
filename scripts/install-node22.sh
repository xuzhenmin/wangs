#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/.runtime"
NODE_LINK="$RUNTIME_DIR/node"
DOWNLOAD_BASE="https://nodejs.org/dist/latest-v22.x"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "此安装脚本仅用于 Linux 服务器。" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *)
    echo "暂不支持当前 CPU 架构：$(uname -m)" >&2
    exit 1
    ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "缺少 curl，请先通过系统包管理器安装 curl。" >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "缺少 tar，请先通过系统包管理器安装 tar。" >&2
  exit 1
fi
if ! command -v xz >/dev/null 2>&1; then
  echo "缺少 xz，请先通过系统包管理器安装 xz。" >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wangs-node22.XXXXXX")"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "正在获取 Node.js 22 官方版本信息…"
curl --fail --silent --show-error --location \
  "$DOWNLOAD_BASE/SHASUMS256.txt" \
  --output "$TEMP_DIR/SHASUMS256.txt"

ARCHIVE_NAME="$(awk -v suffix="linux-$NODE_ARCH.tar.xz" '$2 ~ suffix "$" { print $2; exit }' "$TEMP_DIR/SHASUMS256.txt")"
if [[ -z "$ARCHIVE_NAME" ]]; then
  echo "没有在官方校验清单中找到 Linux $NODE_ARCH 安装包。" >&2
  exit 1
fi

echo "正在下载 $ARCHIVE_NAME …"
curl --fail --silent --show-error --location \
  "$DOWNLOAD_BASE/$ARCHIVE_NAME" \
  --output "$TEMP_DIR/$ARCHIVE_NAME"

EXPECTED_SHA256="$(awk -v file="$ARCHIVE_NAME" '$2 == file { print $1; exit }' "$TEMP_DIR/SHASUMS256.txt")"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$TEMP_DIR/$ARCHIVE_NAME" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(shasum -a 256 "$TEMP_DIR/$ARCHIVE_NAME" | awk '{ print $1 }')"
else
  echo "缺少 sha256sum 或 shasum，无法校验下载文件。" >&2
  exit 1
fi
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "Node.js 安装包 SHA-256 校验失败，已停止安装。" >&2
  exit 1
fi

tar -xJf "$TEMP_DIR/$ARCHIVE_NAME" -C "$TEMP_DIR"
EXTRACTED_NAME="${ARCHIVE_NAME%.tar.xz}"
INSTALL_DIR="$RUNTIME_DIR/$EXTRACTED_NAME"
mkdir -p "$RUNTIME_DIR"
if [[ ! -d "$INSTALL_DIR" ]]; then
  mv "$TEMP_DIR/$EXTRACTED_NAME" "$INSTALL_DIR"
fi
if [[ -e "$NODE_LINK" && ! -L "$NODE_LINK" ]]; then
  echo "$NODE_LINK 已存在且不是符号链接，请先人工确认该目录。" >&2
  exit 1
fi
ln -sfn "$EXTRACTED_NAME" "$NODE_LINK"

NODE_VERSION="$($NODE_LINK/bin/node -v)"
NPM_VERSION="$($NODE_LINK/bin/npm -v)"
echo "安装完成：Node.js $NODE_VERSION，npm $NPM_VERSION"
echo "项目启动脚本将自动使用：$NODE_LINK/bin/node"
echo "现在可以运行：./scripts/start-local.sh"
