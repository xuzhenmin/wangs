#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECK_ONLY=false
INSTALL_HEAP_MB="${NPM_HEAP_MB:-384}"

usage() {
  echo "用法：bash scripts/install-low-memory.sh [--check]"
  echo "  --check     只检查 Node、内存、Swap 和磁盘，不安装依赖。"
  echo "默认安装全部构建依赖，Node 堆上限 384 MiB，可通过 NPM_HEAP_MB 调整。"
}

for argument in "$@"; do
  case "$argument" in
    --check) CHECK_ONLY=true ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
if [[ ! "$INSTALL_HEAP_MB" =~ ^[1-9][0-9]{1,4}$ ]] || (( INSTALL_HEAP_MB < 128 )); then
  echo "NPM_HEAP_MB 必须是至少 128 的整数（MiB）。" >&2
  exit 2
fi

cd "$PROJECT_DIR"
if [[ -x "$PROJECT_DIR/.runtime/node/bin/node" ]]; then
  export PATH="$PROJECT_DIR/.runtime/node/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "请先安装 Node.js 22.13.0 或更新版本：bash scripts/install-node22.sh" >&2
  exit 1
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
  echo "需要 Node.js 22.13.0 或更新版本。" >&2
  exit 1
fi

echo "Node：$(node --version)，npm：$(npm --version)"
echo "项目：$PROJECT_DIR"
df -h "$PROJECT_DIR"
if [[ "$(uname -s)" == "Linux" ]]; then
  free -h
  swapon --show
  # In containerized deployments, host RAM can exceed the process's actual limit.
  CGROUP_RELATIVE="$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)"
  if [[ "$CGROUP_RELATIVE" == /* && "$CGROUP_RELATIVE" != *".."* ]]; then
    for limit_name in memory.max memory.swap.max; do
      limit_path="/sys/fs/cgroup${CGROUP_RELATIVE%/}/$limit_name"
      if [[ -r "$limit_path" ]]; then
        echo "cgroup $limit_name：$(< "$limit_path")"
      fi
    done
  fi
fi
if $CHECK_ONLY; then exit 0; fi

if [[ "$(uname -s)" == "Linux" ]]; then
  AVAILABLE_MEMORY_KB="$(awk '/^MemAvailable:/ { available=$2 } /^SwapFree:/ { swap=$2 } END { print available+swap }' /proc/meminfo)"
  if (( AVAILABLE_MEMORY_KB < (INSTALL_HEAP_MB + 256) * 1024 )); then
    echo "当前可用内存与 Swap 总和不足；未开始 npm ci。" >&2
    echo "请先释放内存、配置 Swap 或增加服务器内存。" >&2
    exit 1
  fi
fi

echo "正在安装构建依赖（Node 堆上限 ${INSTALL_HEAP_MB} MiB；仍需要额外原生内存）…"
echo "npm ci 会重建 node_modules；本脚本不会自动暂停网站。"
set +e
NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$INSTALL_HEAP_MB" \
  UV_THREADPOOL_SIZE=1 npm_config_jobs=1 MAKEFLAGS=-j1 \
  npm ci --include=dev --include=optional --no-audit --no-fund \
    --maxsockets=1 --foreground-scripts --no-progress
INSTALL_STATUS=$?
set -e
if (( INSTALL_STATUS != 0 )); then
  echo "依赖安装失败（退出码 $INSTALL_STATUS）。" >&2
  if (( INSTALL_STATUS == 137 )); then
    echo "进程收到 SIGKILL；请检查 dmesg -T | tail -n 30，以及 cgroup 内存/Swap 限制。" >&2
  else
    echo "若日志出现 JavaScript heap out of memory，有足够 Swap 后可用 NPM_HEAP_MB=512 重试。" >&2
  fi
  exit "$INSTALL_STATUS"
fi
echo "安装完成。更新代码后：LOCAL_BUILD_HEAP_MB=512 bash scripts/start-local.sh"
echo "仅恢复已有生产构建：bash scripts/start-local.sh --skip-build"
