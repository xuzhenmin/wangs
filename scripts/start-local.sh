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
  local listener_pid=""
  if command -v lsof >/dev/null 2>&1; then
    listener_pid="$(lsof -nP -iTCP:"$SITE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
    if [[ -n "$listener_pid" ]]; then
      echo "$listener_pid"
      return
    fi
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

PROJECT_NODE_DIR="$PROJECT_DIR/.runtime/node/bin"
if [[ -x "$PROJECT_NODE_DIR/node" ]]; then
  export PATH="$PROJECT_NODE_DIR:$PATH"
fi

NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"
if [[ -z "$NODE_VERSION" ]] || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' 2>/dev/null; then
  echo "需要 Node.js 22.13.0 或更高版本，当前版本：${NODE_VERSION:-未安装}" >&2
  echo "请先运行：bash scripts/install-node22.sh" >&2
  exit 1
fi

DEPENDENCY_STAMP_FILE="$PROJECT_DIR/.runtime/npm-dependencies.sha256"
DEPENDENCY_FINGERPRINT="$(node --input-type=module -e '
  import { createHash } from "node:crypto";
  import { readFileSync } from "node:fs";
  const hash = createHash("sha256");
  for (const filename of ["package.json", "package-lock.json"]) {
    hash.update(readFileSync(filename));
  }
  process.stdout.write(hash.digest("hex"));
')"
INSTALLED_FINGERPRINT=""
if [[ -f "$DEPENDENCY_STAMP_FILE" ]]; then
  INSTALLED_FINGERPRINT="$(tr -dc 'a-f0-9' < "$DEPENDENCY_STAMP_FILE")"
fi

if [[ ! -x "$PROJECT_DIR/node_modules/.bin/next" || "$INSTALLED_FINGERPRINT" != "$DEPENDENCY_FINGERPRINT" ]]; then
  echo "依赖清单有变化，正在安装依赖…"
  npm ci
  mkdir -p "$(dirname "$DEPENDENCY_STAMP_FILE")"
  printf '%s\n' "$DEPENDENCY_FINGERPRINT" > "$DEPENDENCY_STAMP_FILE"
fi

echo "正在构建 Next.js 生产版本…"
npm run build

echo "正在以 Node.js 模式后台启动网站…"
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
    'cd "$1" && exec "$2" "$3" start --hostname "$4" --port "$5"' \
    _ "$PROJECT_DIR" "$NODE_BIN" "$PROJECT_DIR/node_modules/.bin/next" "$SITE_HOST" "$SITE_PORT"
  SITE_PID=""
else
  nohup "$PROJECT_DIR/node_modules/.bin/next" start \
    --hostname "$SITE_HOST" \
    --port "$SITE_PORT" \
    > "$LOG_FILE" 2>&1 &
  SITE_PID=$!
fi

for _ in {1..160}; do
  LISTENER_PID="$(find_listener_pid)"
  if curl --noproxy "*" --silent --show-error --fail --max-time 2 "$SITE_URL/" >/dev/null 2>&1; then
    if [[ -n "$SITE_PID" ]] && kill -0 "$SITE_PID" 2>/dev/null; then
      echo "$SITE_PID" > "$PID_FILE"
      echo "启动成功：$SITE_URL"
      echo "日志文件：$LOG_FILE"
      exit 0
    fi
    if [[ -n "$LISTENER_PID" ]] && is_this_site_process "$LISTENER_PID"; then
      echo "$LISTENER_PID" > "$PID_FILE"
      echo "启动成功：$SITE_URL"
      echo "日志文件：$LOG_FILE"
      exit 0
    fi
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
