#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.local-site.pid"
SERVICE_LABEL="com.shenxiang.city-news.local"
SITE_PORT="${LOCAL_SITE_PORT:-3217}"

find_listener_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$SITE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null \
      | awk -v port=":$SITE_PORT" '$4 ~ port "$"' \
      | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
      | head -n 1 || true
  fi
}

is_this_site_process() {
  local candidate_pid="$1"
  local candidate_command
  local candidate_cwd
  candidate_command="$(ps -p "$candidate_pid" -o command= 2>/dev/null || true)"
  if [[ -e "/proc/$candidate_pid/cwd" ]]; then
    candidate_cwd="$(readlink -f "/proc/$candidate_pid/cwd" 2>/dev/null || true)"
  else
    candidate_cwd="$(lsof -a -p "$candidate_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  fi
  [[ "$candidate_cwd" == "$PROJECT_DIR" && "$candidate_command" == *"next"* ]]
}

if [[ "$(uname -s)" == "Darwin" ]] && \
  launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$SERVICE_LABEL"
  rm -f "$PID_FILE"
  echo "本地网站已暂停。"
  exit 0
fi

SITE_PID=""
if [[ -f "$PID_FILE" ]]; then
  SITE_PID="$(tr -dc '0-9' < "$PID_FILE")"
fi

if [[ -z "$SITE_PID" ]] || ! kill -0 "$SITE_PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  SITE_PID="$(find_listener_pid)"
  if [[ -z "$SITE_PID" ]]; then
    echo "本地网站当前没有运行。"
    exit 0
  fi
  if ! is_this_site_process "$SITE_PID"; then
    echo "端口 $SITE_PORT 正由其他程序使用，为避免误杀，未停止该进程。" >&2
    echo "进程号：$SITE_PID" >&2
    exit 1
  fi
  echo "$SITE_PID" > "$PID_FILE"
  echo "已从端口 $SITE_PORT 恢复网站进程记录。"
fi

if ! is_this_site_process "$SITE_PID"; then
  rm -f "$PID_FILE"
  echo "进程 $SITE_PID 不属于当前网站，为避免误杀，未停止该进程。" >&2
  exit 1
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
