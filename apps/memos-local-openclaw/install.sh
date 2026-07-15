#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'
DEFAULT_TAGLINE="Memos Local Memory for OpenClaw."
DEFAULT_SUBTITLE="Keep your context, tasks, and recall in one local memory engine."

info() {
  echo -e "${BLUE}$1${NC}"
}

success() {
  echo -e "${GREEN}$1${NC}"
}

warn() {
  echo -e "${YELLOW}$1${NC}"
}

error() {
  echo -e "${RED}$1${NC}"
}

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "0"
    return 0
  fi
  local node_version
  node_version="$(node -v 2>/dev/null || true)"
  node_version="${node_version#v}"
  echo "${node_version%%.*}"
}

run_with_privilege() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

download_to_file() {
  local url="$1"
  local output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$output"
    return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q --https-only --secure-protocol=TLSv1_2 "$url" -O "$output"
    return 0
  fi
  return 1
}

install_node22() {
  local os_name
  os_name="$(uname -s)"

  if [[ "$os_name" == "Darwin" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      error "Homebrew is required to auto-install Node.js on macOS, macOS 自动安装 Node.js 需要 Homebrew"
      error "Install Homebrew first, 请先安装 Homebrew: https://brew.sh"
      exit 1
    fi
    info "Auto install Node.js 22 via Homebrew, 通过 Homebrew 自动安装 Node.js 22..."
    brew install node@22 >/dev/null
    brew link node@22 --overwrite --force >/dev/null 2>&1 || true
    local brew_node_prefix
    brew_node_prefix="$(brew --prefix node@22 2>/dev/null || true)"
    if [[ -n "$brew_node_prefix" && -x "${brew_node_prefix}/bin/node" ]]; then
      export PATH="${brew_node_prefix}/bin:${PATH}"
    fi
    return 0
  fi

  if [[ "$os_name" == "Linux" ]]; then
    info "Auto install Node.js 22 on Linux, 在 Linux 自动安装 Node.js 22..."
    local tmp_script
    tmp_script="$(mktemp)"
    if command -v apt-get >/dev/null 2>&1; then
      if ! download_to_file "https://deb.nodesource.com/setup_22.x" "$tmp_script"; then
        error "Failed to download NodeSource setup script, 下载 NodeSource 脚本失败"
        rm -f "$tmp_script"
        exit 1
      fi
      run_with_privilege bash "$tmp_script"
      run_with_privilege apt-get update -qq
      run_with_privilege apt-get install -y -qq nodejs
      rm -f "$tmp_script"
      return 0
    fi
    if command -v dnf >/dev/null 2>&1; then
      if ! download_to_file "https://rpm.nodesource.com/setup_22.x" "$tmp_script"; then
        error "Failed to download NodeSource setup script, 下载 NodeSource 脚本失败"
        rm -f "$tmp_script"
        exit 1
      fi
      run_with_privilege bash "$tmp_script"
      run_with_privilege dnf install -y -q nodejs
      rm -f "$tmp_script"
      return 0
    fi
    if command -v yum >/dev/null 2>&1; then
      if ! download_to_file "https://rpm.nodesource.com/setup_22.x" "$tmp_script"; then
        error "Failed to download NodeSource setup script, 下载 NodeSource 脚本失败"
        rm -f "$tmp_script"
        exit 1
      fi
      run_with_privilege bash "$tmp_script"
      run_with_privilege yum install -y -q nodejs
      rm -f "$tmp_script"
      return 0
    fi
    rm -f "$tmp_script"
  fi

  error "Unsupported platform for auto-install, 当前平台不支持自动安装 Node.js 22"
  error "Please install Node.js >=22 manually, 请手动安装 Node.js >=22"
  exit 1
}

ensure_node22() {
  local required_major="22"
  local current_major
  current_major="$(node_major_version)"

  if [[ "$current_major" =~ ^[0-9]+$ ]] && (( current_major >= required_major )); then
    success "Node.js version check passed (>= ${required_major}), Node.js 版本检查通过 (>= ${required_major})"
    return 0
  fi

  warn "Node.js >= ${required_major} is required, 需要 Node.js >= ${required_major}"
  warn "Current Node.js is too old or missing, 当前 Node.js 版本过低或不存在，开始自动安装..."
  install_node22

  current_major="$(node_major_version)"
  if [[ "$current_major" =~ ^[0-9]+$ ]] && (( current_major >= required_major )); then
    success "Node.js upgraded and ready, Node.js 已升级并可用: $(node -v)"
    return 0
  fi

  error "Node.js installation did not meet >= ${required_major}, Node.js 安装后仍不满足 >= ${required_major}"
  exit 1
}

resolve_openclaw_bin() {
  if command -v openclaw >/dev/null 2>&1; then
    command -v openclaw
    return 0
  fi

  error "Global openclaw CLI not found, 未找到全局 openclaw 命令"
  error "Install it first with: npm install -g openclaw@latest"
  exit 1
}

print_banner() {
  echo -e "${BLUE}${BOLD}🧠 Memos Local OpenClaw Installer${NC}"
  echo -e "${BLUE}${DEFAULT_TAGLINE}${NC}"
  echo -e "${YELLOW}${DEFAULT_SUBTITLE}${NC}"
}

PLUGIN_ID="memos-local-openclaw-plugin"
PLUGIN_PACKAGE="@memtensor/memos-local-openclaw-plugin"
PLUGIN_VERSION="latest"
PORT="18789"
OPENCLAW_HOME="${HOME}/.openclaw"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      PLUGIN_VERSION="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --openclaw-home)
      OPENCLAW_HOME="${2:-}"
      shift 2
      ;;
    *)
      error "Unknown argument, 未知参数: $1"
      warn "Usage: bash install.sh [--version <version>] [--port <port>] [--openclaw-home <path>]"
      exit 1
      ;;
  esac
done

if [[ -z "$PLUGIN_VERSION" || -z "$PORT" || -z "$OPENCLAW_HOME" ]]; then
  error "Arguments cannot be empty, 参数不能为空"
  exit 1
fi

print_banner

ensure_node22

if ! command -v npx >/dev/null 2>&1; then
  error "npx not found after Node.js setup, Node.js 安装后仍未找到 npx"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  error "npm not found after Node.js setup, Node.js 安装后仍未找到 npm"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  error "node not found after setup, 环境初始化后仍未找到 node"
  exit 1
fi

OPENCLAW_BIN="$(resolve_openclaw_bin)"
success "Using global OpenClaw CLI, 使用全局 OpenClaw CLI: ${OPENCLAW_BIN}"

PACKAGE_SPEC="${PLUGIN_PACKAGE}@${PLUGIN_VERSION}"
EXTENSION_DIR="${OPENCLAW_HOME}/extensions/${PLUGIN_ID}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_HOME}/openclaw.json"

update_openclaw_config() {
  info "Update OpenClaw config, 更新 OpenClaw 配置..."
  mkdir -p "${OPENCLAW_HOME}"
  node - "${OPENCLAW_CONFIG_PATH}" "${PLUGIN_ID}" "${EXTENSION_DIR}" "${PACKAGE_SPEC}" <<'NODE'
const fs = require('fs');
const path = require('path');

const configPath = process.argv[2];
const pluginId = process.argv[3];
const installPath = process.argv[4];
const spec = process.argv[5];

let config = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, 'utf8').trim();
  if (raw.length > 0) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed;
    }
  }
}

if (!config.plugins || typeof config.plugins !== 'object' || Array.isArray(config.plugins)) {
  config.plugins = {};
}

config.plugins.enabled = true;

if (!Array.isArray(config.plugins.allow)) {
  config.plugins.allow = [];
}

if (!config.plugins.allow.includes(pluginId)) {
  config.plugins.allow.push(pluginId);
}

// Clean up stale contextEngine slot from previous versions
if (config.plugins.slots && config.plugins.slots.contextEngine) {
  delete config.plugins.slots.contextEngine;
  if (Object.keys(config.plugins.slots).length === 0) {
    delete config.plugins.slots;
  }
}

// Register plugin in memory slot
if (!config.plugins.slots || typeof config.plugins.slots !== 'object') {
  config.plugins.slots = {};
}
config.plugins.slots.memory = pluginId;

// Ensure plugin entry is enabled (preserve existing config if present)
if (!config.plugins.entries || typeof config.plugins.entries !== 'object') {
  config.plugins.entries = {};
}
if (!config.plugins.entries[pluginId] || typeof config.plugins.entries[pluginId] !== 'object') {
  config.plugins.entries[pluginId] = {};
}
config.plugins.entries[pluginId].enabled = true;

// Register plugin in installs so gateway auto-loads it on restart (pinned spec when package.json exists)
if (!config.plugins.installs || typeof config.plugins.installs !== 'object') {
  config.plugins.installs = {};
}
let resolvedName = '';
let resolvedVersion = '';
const pkgJsonPath = path.join(installPath, 'package.json');
if (fs.existsSync(pkgJsonPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  resolvedName = pkg.name;
  resolvedVersion = pkg.version;
}
const pinnedSpec = resolvedName && resolvedVersion ? `${resolvedName}@${resolvedVersion}` : spec;
config.plugins.installs[pluginId] = {
  source: 'npm',
  spec: pinnedSpec,
  installPath,
  ...(resolvedVersion ? { version: resolvedVersion } : {}),
  ...(resolvedName ? { resolvedName } : {}),
  ...(resolvedVersion ? { resolvedVersion } : {}),
  ...(resolvedName && resolvedVersion ? { resolvedSpec: pinnedSpec } : {}),
  installedAt: new Date().toISOString(),
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
NODE
  success "OpenClaw config updated, OpenClaw 配置已更新: ${OPENCLAW_CONFIG_PATH}"
}

info "Stop OpenClaw Gateway, 停止 OpenClaw Gateway..."
"${OPENCLAW_BIN}" gateway stop >/dev/null 2>&1 || true

if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -i :"${PORT}" -t 2>/dev/null || true)"
  if [[ -n "$PIDS" ]]; then
    warn "Processes still on port ${PORT}, 检测到端口 ${PORT} 仍有进程，占用 PID: ${PIDS}"
    echo "$PIDS" | xargs kill -9 >/dev/null 2>&1 || true
  fi
fi

info "Remove old plugin directory if exists, 清理旧插件目录（若存在）..."
if [[ -d "${EXTENSION_DIR}" ]]; then
  rm -rf "${EXTENSION_DIR}"
  success "Old plugin directory removed, 旧插件目录已清理"
fi

info "Install plugin ${PACKAGE_SPEC}, 安装插件 ${PACKAGE_SPEC}..."
TMP_PACK_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_PACK_DIR}"' EXIT

if [[ -f "${PLUGIN_VERSION}" ]]; then
  info "Using local tarball, 使用本地包: ${PLUGIN_VERSION}"
  cp "${PLUGIN_VERSION}" "${TMP_PACK_DIR}/plugin.tgz"
else
  info "Downloading package from npm, 从 npm 下载包..."
  npm pack "${PACKAGE_SPEC}" --pack-destination "${TMP_PACK_DIR}" >/dev/null 2>&1
  TARBALL="$(ls "${TMP_PACK_DIR}"/*.tgz 2>/dev/null | head -1)"
  if [[ -z "$TARBALL" || ! -f "$TARBALL" ]]; then
    error "Failed to download package, 下载包失败: ${PACKAGE_SPEC}"
    exit 1
  fi
  mv "$TARBALL" "${TMP_PACK_DIR}/plugin.tgz"
fi

mkdir -p "${EXTENSION_DIR}"
tar xzf "${TMP_PACK_DIR}/plugin.tgz" -C "${EXTENSION_DIR}" --strip-components=1

if [[ ! -f "${EXTENSION_DIR}/package.json" ]]; then
  error "Plugin extraction failed — package.json not found, 插件解压失败"
  exit 1
fi

info "Install dependencies, 安装依赖..."
(
  cd "${EXTENSION_DIR}"
  MEMOS_SKIP_SETUP=1 npm install --omit=dev --no-fund --no-audit --loglevel=error 2>&1
)

if [[ ! -d "${EXTENSION_DIR}/node_modules" ]] || [[ -z "$(ls -A "${EXTENSION_DIR}/node_modules" 2>/dev/null)" ]]; then
  warn "node_modules was cleaned by postinstall (version upgrade detected), re-installing..."
  (
    cd "${EXTENSION_DIR}"
    MEMOS_SKIP_SETUP=1 npm install --omit=dev --no-fund --no-audit --loglevel=error 2>&1
  )
fi

if [[ ! -d "$EXTENSION_DIR" ]]; then
  error "Plugin directory not found after install, 安装后未找到插件目录: ${EXTENSION_DIR}"
  exit 1
fi

if [[ ! -d "${EXTENSION_DIR}/node_modules" ]]; then
  warn "node_modules missing after install (postinstall may have cleaned it), 安装后 node_modules 缺失，正在重新安装..."
  (
    cd "${EXTENSION_DIR}"
    npm install --omit=dev --no-fund --no-audit --ignore-scripts --loglevel=error 2>&1
  )
fi

if [[ ! -d "${EXTENSION_DIR}/node_modules/better-sqlite3" ]]; then
  warn "better-sqlite3 missing, attempting rebuild, better-sqlite3 缺失，尝试重新编译..."
  (
    cd "${EXTENSION_DIR}"
    npm rebuild better-sqlite3 2>&1 || true
  )
fi

if [[ ! -d "${EXTENSION_DIR}/node_modules" ]]; then
  error "Dependencies installation failed. Run manually: cd ${EXTENSION_DIR} && npm install --omit=dev"
  error "依赖安装失败，请手动运行: cd ${EXTENSION_DIR} && npm install --omit=dev"
  exit 1
fi

update_openclaw_config

info "Install OpenClaw Gateway service, 安装 OpenClaw Gateway 服务..."
"${OPENCLAW_BIN}" gateway install --port "${PORT}" --force 2>&1 || true

success "Start OpenClaw Gateway service, 启动 OpenClaw Gateway 服务..."
"${OPENCLAW_BIN}" gateway start 2>&1

info "Starting Memory Viewer, 正在启动记忆面板..."
VIEWER_URL="http://127.0.0.1:18799"
VIEWER_WAIT_SECONDS=30
viewer_ready=0
for ((i=1; i<=VIEWER_WAIT_SECONDS; i++)); do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 2 "${VIEWER_URL}" >/dev/null 2>&1; then
      viewer_ready=1
      break
    fi
  elif command -v lsof >/dev/null 2>&1 && lsof -i :18799 -t >/dev/null 2>&1; then
    viewer_ready=1
    break
  fi
  printf "."
  sleep 1
done
echo ""

if [[ "${viewer_ready}" -eq 1 ]]; then
  success "Memory Viewer is ready, 记忆面板已就绪: ${VIEWER_URL}"
else
  warn "Memory Viewer not ready after ${VIEWER_WAIT_SECONDS}s, 记忆面板在 ${VIEWER_WAIT_SECONDS} 秒后仍未就绪"
  warn "Check gateway logs if http://127.0.0.1:18799 is still unavailable."
fi

echo ""
success "=========================================="
success "  Installation complete! 安装完成!"
success "=========================================="
echo ""
info "  OpenClaw Web UI:      http://localhost:${PORT}"
info "  Memory Viewer:        http://localhost:18799"
echo ""
