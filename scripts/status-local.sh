#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.local-site.pid"
LOG_FILE="$PROJECT_DIR/.local-site.log"
SITE_PORT="${LOCAL_SITE_PORT:-3217}"
SERVICE_LABEL="com.shenxiang.city-news.local"
SITE_HOST="${LOCAL_SITE_HOST:-127.0.0.1}"
SITE_URL_HOST="$SITE_HOST"

if [[ "$SITE_HOST" == "0.0.0.0" || "$SITE_HOST" == "::" ]]; then
  SITE_URL_HOST="127.0.0.1"
fi

SITE_URL="http://$SITE_URL_HOST:$SITE_PORT"

find_listener_pid() {
  lsof -nP -iTCP:"$SITE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
}

if [[ "$(uname -s)" == "Darwin" ]] && \
  launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
  LISTENER_PID="$(find_listener_pid)"
  if [[ -n "$LISTENER_PID" ]]; then
    echo "$LISTENER_PID" > "$PID_FILE"
    echo "状态：运行中（进程号 $LISTENER_PID）"
    echo "地址：$SITE_URL"
    echo "日志：$LOG_FILE"
    exit 0
  fi
  echo "状态：后台服务正在启动，或已异常退出"
  echo "日志：$LOG_FILE"
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  SITE_PID="$(tr -dc '0-9' < "$PID_FILE")"
  if [[ -n "$SITE_PID" ]] && kill -0 "$SITE_PID" 2>/dev/null; then
    echo "状态：运行中（进程号 $SITE_PID）"
    echo "地址：$SITE_URL"
    echo "日志：$LOG_FILE"
    exit 0
  fi
fi

LISTENER_PID="$(find_listener_pid)"
if [[ -n "$LISTENER_PID" ]]; then
  LISTENER_COMMAND="$(ps -p "$LISTENER_PID" -o command= 2>/dev/null || true)"
  if [[ "$LISTENER_COMMAND" == *"$PROJECT_DIR"* && "$LISTENER_COMMAND" == *"vinext dev"* ]]; then
    echo "状态：运行中（进程号 $LISTENER_PID）"
    echo "地址：$SITE_URL"
    echo "提示：进程记录缺失，再次运行启动命令可自动恢复。"
    exit 0
  fi
fi

echo "状态：已暂停"
