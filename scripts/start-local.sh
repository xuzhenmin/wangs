#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.local-site.pid"
LOG_FILE="$PROJECT_DIR/.local-site.log"
SITE_PORT="${LOCAL_SITE_PORT:-3217}"
SITE_HOST="${LOCAL_SITE_HOST:-127.0.0.1}"
SERVICE_LABEL="com.shenxiang.city-news.local"
SITE_URL_HOST="$SITE_HOST"

if [[ "$SITE_HOST" == "0.0.0.0" || "$SITE_HOST" == "::" ]]; then
  SITE_URL_HOST="127.0.0.1"
fi

SITE_URL="http://$SITE_URL_HOST:$SITE_PORT"

can_use_launchd() {
  [[ "$(uname -s)" == "Darwin" ]] && \
    launchctl print "gui/$(id -u)" >/dev/null 2>&1
}

launchd_service_exists() {
  launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1
}

find_listener_pid() {
  lsof -nP -iTCP:"$SITE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
}

is_this_site_process() {
  local candidate_pid="$1"
  local candidate_command
  candidate_command="$(ps -p "$candidate_pid" -o command= 2>/dev/null || true)"
  [[ "$candidate_command" == *"$PROJECT_DIR"* && "$candidate_command" == *"vinext dev"* ]]
}

if [[ -f "$PID_FILE" ]]; then
  RUNNING_PID="$(tr -dc '0-9' < "$PID_FILE")"
  if [[ -n "$RUNNING_PID" ]] && kill -0 "$RUNNING_PID" 2>/dev/null; then
    echo "本地网站已经在运行：$SITE_URL"
    echo "进程号：$RUNNING_PID"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

EXISTING_LISTENER="$(find_listener_pid)"
if [[ -n "$EXISTING_LISTENER" ]]; then
  if is_this_site_process "$EXISTING_LISTENER"; then
    echo "$EXISTING_LISTENER" > "$PID_FILE"
    echo "本地网站已经在运行：$SITE_URL"
    echo "进程号：$EXISTING_LISTENER"
    exit 0
  fi
  echo "端口 $SITE_PORT 已被其他程序占用，请改用其他端口，例如：" >&2
  echo "LOCAL_SITE_PORT=3218 npm run local:start" >&2
  exit 1
fi

cd "$PROJECT_DIR"

if [[ ! -x "$PROJECT_DIR/node_modules/.bin/vinext" ]]; then
  echo "首次运行，正在安装依赖…"
  npm install
fi

echo "正在以 Cloudflare 兼容模式后台启动网站…"
if can_use_launchd; then
  NODE_BIN="$(command -v node)"
  if launchd_service_exists; then
    launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || true
    for _ in {1..20}; do
      if ! launchd_service_exists; then
        break
      fi
      sleep 0.1
    done
  fi
  : > "$LOG_FILE"
  launchctl submit \
    -l "$SERVICE_LABEL" \
    -o "$LOG_FILE" \
    -e "$LOG_FILE" \
    -- /bin/bash -c \
    'cd "$1" && exec env WRANGLER_LOG_PATH=.wrangler/wrangler.log "$2" "$3" dev --hostname "$4" --port "$5"' \
    _ "$PROJECT_DIR" "$NODE_BIN" "$PROJECT_DIR/node_modules/.bin/vinext" "$SITE_HOST" "$SITE_PORT"
  SITE_PID=""
else
  WRANGLER_LOG_PATH=.wrangler/wrangler.log nohup "$PROJECT_DIR/node_modules/.bin/vinext" dev \
    --hostname "$SITE_HOST" \
    --port "$SITE_PORT" \
    > "$LOG_FILE" 2>&1 &
  SITE_PID=$!
fi

for _ in {1..160}; do
  LISTENER_PID="$(find_listener_pid)"
  if [[ -n "$LISTENER_PID" ]] && is_this_site_process "$LISTENER_PID" && \
    curl --silent --show-error --fail --max-time 2 "$SITE_URL/" >/dev/null 2>&1; then
    echo "$LISTENER_PID" > "$PID_FILE"
    echo "启动成功：$SITE_URL"
    echo "日志文件：$LOG_FILE"
    exit 0
  fi
  if [[ -n "$SITE_PID" ]] && ! kill -0 "$SITE_PID" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

rm -f "$PID_FILE"
if can_use_launchd && launchd_service_exists; then
  launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || true
fi
echo "启动失败，最近的日志如下：" >&2
tail -n 30 "$LOG_FILE" >&2
exit 1
