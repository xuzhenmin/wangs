#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.local-site.pid"
SERVICE_LABEL="com.shenxiang.city-news.local"

if [[ "$(uname -s)" == "Darwin" ]] && \
  launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$SERVICE_LABEL"
  rm -f "$PID_FILE"
  echo "本地网站已暂停。"
  exit 0
fi

if [[ ! -f "$PID_FILE" ]]; then
  echo "本地网站当前没有运行。"
  exit 0
fi

SITE_PID="$(tr -dc '0-9' < "$PID_FILE")"
if [[ -z "$SITE_PID" ]]; then
  rm -f "$PID_FILE"
  echo "已清理无效的进程记录。"
  exit 0
fi

if ! kill -0 "$SITE_PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "网站进程已停止，已清理状态记录。"
  exit 0
fi

kill "$SITE_PID"
for _ in {1..20}; do
  if ! kill -0 "$SITE_PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "本地网站已暂停。"
    exit 0
  fi
  sleep 0.25
done

echo "网站进程尚未退出，请稍后再次运行暂停命令。" >&2
exit 1
