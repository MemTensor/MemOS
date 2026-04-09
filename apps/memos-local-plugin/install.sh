#!/usr/bin/env bash
set -euo pipefail

# ─── MemTensor Memory for Hermes Agent — One-line Installer ───
#
# Usage (remote):
#   curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/openclaw-local-plugin-20260408/apps/memos-local-plugin/install.sh | bash
#   curl ... | bash -s -- --version 1.0.0-beta.1
#
# Usage (local, after extracting the npm package):
#   bash install.sh
#
# Options:
#   --version <ver>            - Install a specific version (default: latest from npm)
#
# Environment variables:
#   MEMOS_INSTALL_DIR          - Override install directory (default: ~/.hermes/memos-plugin)
#   MEMOS_STATE_DIR            - Override memory DB location
#   MEMOS_DAEMON_PORT          - Bridge daemon port (default: 18992)
#   MEMOS_VIEWER_PORT          - Memory viewer port (default: 18901)
#   MEMOS_EMBEDDING_PROVIDER   - Embedding provider (default: local)

# ─── Config ───

NPM_PACKAGE="@memtensor/memos-local-hermes-plugin"
INSTALL_DIR="${MEMOS_INSTALL_DIR:-$HOME/.hermes/memos-plugin}"
PKG_VERSION=""

# ─── Parse arguments ───

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      PKG_VERSION="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# ─── Colors ───

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()    { echo -e "${BLUE}$1${NC}"; }
success() { echo -e "${GREEN}✓ $1${NC}"; }
warn()    { echo -e "${YELLOW}⚠ $1${NC}"; }
error()   { echo -e "${RED}✗ $1${NC}"; }
header()  { echo -e "\n${BOLD}${BLUE}── $1 ──${NC}\n"; }

# ─── Banner ───

echo ""
echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║   🧠  MemTensor Memory for Hermes Agent         ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo -e "${DIM}Persistent semantic memory with hybrid search.${NC}"
echo ""

# ─── Detect execution mode ───
# If bridge.cts exists in the same directory, we're running from an extracted package (local mode).
# Otherwise, we need to download the package from npm (remote mode).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
LOCAL_MODE=false
if [[ -f "$SCRIPT_DIR/bridge.cts" && -f "$SCRIPT_DIR/package.json" ]]; then
  LOCAL_MODE=true
  INSTALL_DIR="$SCRIPT_DIR"
fi

# ═══════════════════════════════════════════════════
# Step 1: Environment Check
# ═══════════════════════════════════════════════════

header "环境检查 / Environment Check"

# ── Hermes Agent ──
if [[ ! -d "$HOME/.hermes/hermes-agent" ]]; then
  error "Hermes Agent not found. 未找到 Hermes Agent"
  error "Please install Hermes first: https://github.com/NousResearch/hermes-agent"
  exit 1
fi
success "Hermes Agent: $HOME/.hermes/hermes-agent"

# ── Node.js ──
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js not found. Attempting to install Node.js 22..."
  warn "未找到 Node.js，正在自动安装 Node.js 22..."

  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    yum install -y nodejs >/dev/null 2>&1
  elif command -v brew >/dev/null 2>&1; then
    brew install node@22 >/dev/null 2>&1
  else
    error "Cannot auto-install Node.js. Please install Node.js >= 18 manually."
    error "无法自动安装 Node.js，请手动安装 Node.js >= 18"
    error "  https://nodejs.org/"
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    error "Node.js installation failed. Please install manually."
    exit 1
  fi
  success "Node.js $(node -v) (auto-installed)"
else
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_VERSION" -lt 18 ]]; then
    error "Node.js >= 18 required, current: $(node -v)"
    error "需要 Node.js >= 18，当前: $(node -v)"
    exit 1
  fi
  success "Node.js $(node -v)"
fi

if ! command -v npm >/dev/null 2>&1; then
  error "npm not found. 未找到 npm"
  exit 1
fi
success "npm $(npm -v)"

# ── Find hermes Python (venv) ──
hermes_python=""

hermes_bin=$(command -v hermes 2>/dev/null || true)
if [[ -z "$hermes_bin" && -x "$HOME/.local/bin/hermes" ]]; then
  hermes_bin="$HOME/.local/bin/hermes"
fi

if [[ -n "$hermes_bin" ]]; then
  shebang=$(head -1 "$hermes_bin" 2>/dev/null || true)
  if [[ "$shebang" == "#!"*python* ]]; then
    hermes_python=$(echo "$shebang" | sed 's/^#!\s*//')
  fi
fi

if [[ -z "$hermes_python" || ! -x "$hermes_python" ]]; then
  venv_python="$HOME/.hermes/hermes-agent/venv/bin/python3"
  if [[ -x "$venv_python" ]]; then
    hermes_python="$venv_python"
  fi
fi

if [[ -z "$hermes_python" || ! -x "$hermes_python" ]] && [[ -n "$hermes_bin" ]]; then
  real_bin=$(readlink -f "$hermes_bin" 2>/dev/null || true)
  if [[ -n "$real_bin" ]]; then
    bin_dir=$(dirname "$real_bin")
    for p in "$bin_dir/python3" "$bin_dir/python"; do
      if [[ -x "$p" ]]; then
        hermes_python="$p"
        break
      fi
    done
  fi
fi

if [[ -z "$hermes_python" || ! -x "$hermes_python" ]]; then
  hermes_python="python3"
fi
success "Hermes Python: $hermes_python"

# ═══════════════════════════════════════════════════
# Step 2: Download & Install npm Package
# ═══════════════════════════════════════════════════

if $LOCAL_MODE; then
  header "安装核心依赖 / Install Dependencies (local mode)"
  info "Plugin directory: $INSTALL_DIR"
  cd "$INSTALL_DIR"
  npm install --no-fund --no-audit --loglevel=error
  success "Dependencies installed 依赖已安装"
else
  header "下载并安装插件 / Download & Install Plugin"
  info "Package: $NPM_PACKAGE"
  info "Install to: $INSTALL_DIR"

  TMP_DIR=$(mktemp -d)
  trap "rm -rf '$TMP_DIR'" EXIT

  cd "$TMP_DIR"

  # Resolve version: use --version if given, otherwise query npm for latest
  if [[ -z "$PKG_VERSION" ]]; then
    PKG_VERSION=$(npm view "$NPM_PACKAGE" dist-tags.latest 2>/dev/null || true)
    if [[ -z "$PKG_VERSION" ]]; then
      PKG_VERSION=$(npm view "$NPM_PACKAGE" version 2>/dev/null || true)
    fi
    if [[ -z "$PKG_VERSION" ]]; then
      error "Cannot determine latest version of $NPM_PACKAGE"
      error "Use --version to specify: bash install.sh --version 1.0.0-beta.1"
      exit 1
    fi
  fi

  info "Downloading $NPM_PACKAGE@$PKG_VERSION from npm..."
  npm pack "$NPM_PACKAGE@$PKG_VERSION" --loglevel=error 2>/dev/null
  TARBALL=$(ls -1 memtensor-memos-local-hermes-plugin-*.tgz 2>/dev/null | head -1)

  if [[ -z "$TARBALL" || ! -f "$TARBALL" ]]; then
    error "Failed to download $NPM_PACKAGE from npm"
    error "下载 npm 包失败"
    exit 1
  fi
  success "Package downloaded: $TARBALL"

  tar xzf "$TARBALL"
  if [[ ! -d "package" ]]; then
    error "Package extraction failed"
    exit 1
  fi

  # Remove old installation if exists
  if [[ -d "$INSTALL_DIR" ]]; then
    # Preserve node_modules to speed up reinstall
    if [[ -d "$INSTALL_DIR/node_modules" ]]; then
      mv "$INSTALL_DIR/node_modules" "$TMP_DIR/_saved_node_modules" 2>/dev/null || true
    fi
    rm -rf "$INSTALL_DIR"
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  mv package "$INSTALL_DIR"

  # Restore node_modules if we saved them
  if [[ -d "$TMP_DIR/_saved_node_modules" ]]; then
    mv "$TMP_DIR/_saved_node_modules" "$INSTALL_DIR/node_modules"
  fi

  cd "$INSTALL_DIR"
  info "Installing dependencies..."
  npm install --no-fund --no-audit --loglevel=error
  success "Plugin installed to $INSTALL_DIR"
fi

# Verify bridge.cts
BRIDGE_CTS="$INSTALL_DIR/bridge.cts"
if [[ ! -f "$BRIDGE_CTS" ]]; then
  error "bridge.cts not found at $BRIDGE_CTS"
  exit 1
fi
success "Bridge script ready"

# ═══════════════════════════════════════════════════
# Step 3: Configure Hermes Adapter
# ═══════════════════════════════════════════════════

header "配置 Hermes 适配器 / Configure Hermes Adapter"

ADAPTER_DIR="$INSTALL_DIR/adapters/hermes"

if [[ ! -d "$ADAPTER_DIR" ]]; then
  error "Hermes adapter not found: $ADAPTER_DIR"
  exit 1
fi

# Record bridge path
echo "$BRIDGE_CTS" > "$ADAPTER_DIR/bridge_path.txt"
success "Bridge path recorded"

# ── Detect hermes plugins/memory directory ──
hermes_plugin_dir=""

hermes_plugin_dir=$("$hermes_python" -c "
from pathlib import Path
import plugins.memory as pm
print(Path(pm.__file__).parent)
" 2>/dev/null) || true

if [[ -z "$hermes_plugin_dir" || ! -d "$hermes_plugin_dir" ]]; then
  search_dirs=(
    "$HOME/.hermes/hermes-agent/plugins/memory"
  )
  site_pkg=$("$hermes_python" -c "import site; [print(p) for p in site.getsitepackages()]" 2>/dev/null | head -1) || true
  [[ -n "$site_pkg" ]] && search_dirs+=("$site_pkg/plugins/memory")

  for d in "${search_dirs[@]}"; do
    if [[ -d "$d" && -f "$d/__init__.py" ]]; then
      hermes_plugin_dir="$d"
      break
    fi
  done
fi

if [[ -z "$hermes_plugin_dir" || ! -d "$hermes_plugin_dir" ]]; then
  error "Cannot find hermes plugins/memory directory"
  error "无法定位 hermes 插件目录"
  exit 1
fi

TARGET_LINK="$hermes_plugin_dir/memtensor"

info "Adapter:    $ADAPTER_DIR"
info "Plugin dir: $hermes_plugin_dir"
info "Symlink:    $TARGET_LINK"

# ── Create symlink ──
if [[ -L "$TARGET_LINK" ]]; then
  rm "$TARGET_LINK"
elif [[ -d "$TARGET_LINK" ]]; then
  rm -rf "$TARGET_LINK"
fi

ln -s "$ADAPTER_DIR" "$TARGET_LINK"
success "Symlink created"

# ── Verify plugin loads ──
verify_ok=$("$hermes_python" -c "
from plugins.memory import load_memory_provider
p = load_memory_provider('memtensor')
if p and p.name == 'memtensor':
    print('OK')
else:
    print('FAIL')
" 2>/dev/null) || true

if [[ "$verify_ok" == "OK" ]]; then
  success "Plugin verification passed 插件加载验证通过"
else
  warn "Plugin verification failed — may need manual check"
fi

# ═══════════════════════════════════════════════════
# Step 4: Update config.yaml
# ═══════════════════════════════════════════════════

header "更新配置 / Update Config"

CONFIG_FILE="$HOME/.hermes/config.yaml"
if [[ -f "$CONFIG_FILE" ]]; then
  info "Updating $CONFIG_FILE ..."

  config_result=$("$hermes_python" << 'PYEOF'
import yaml, os

config_file = os.path.expanduser("~/.hermes/config.yaml")

with open(config_file) as f:
    raw = f.read()

cfg = yaml.safe_load(raw) or {}
mem = cfg.get("memory")

if isinstance(mem, dict):
    mem["provider"] = "memtensor"
else:
    cfg["memory"] = {"provider": "memtensor"}

with open(config_file, "w") as f:
    yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

with open(config_file) as f:
    check = yaml.safe_load(f)
val = (check or {}).get("memory", {}).get("provider", "")
if val == "memtensor":
    print("OK")
else:
    print("FAIL: provider is " + repr(val))
PYEOF
  ) || true

  if [[ "$config_result" == "OK" ]]; then
    success "config.yaml updated: memory.provider = memtensor"
  else
    warn "Auto-update failed. Please manually set in ~/.hermes/config.yaml:"
    warn "  memory:"
    warn "    provider: memtensor"
  fi
else
  mkdir -p "$HOME/.hermes"
  cat > "$CONFIG_FILE" << 'CFGEOF'
memory:
  memory_enabled: true
  user_profile_enabled: true
  provider: memtensor
CFGEOF
  success "Created $CONFIG_FILE"
fi

# ═══════════════════════════════════════════════════
# Step 5: Kill old hermes & daemon, restart
# ═══════════════════════════════════════════════════

header "重启服务 / Restart Services"

# Kill old daemon
pkill -f "bridge.cts.*daemon" 2>/dev/null || true
rm -rf "$HOME/.hermes/memos-state/daemon/" 2>/dev/null || true

# Kill old hermes (it loaded old config, needs restart to pick up memtensor)
HERMES_WAS_RUNNING=false
if pgrep -f "hermes" >/dev/null 2>&1; then
  HERMES_WAS_RUNNING=true
  info "Stopping running hermes process..."
  info "正在停止运行中的 hermes 进程..."
  pkill -f "/bin/hermes" 2>/dev/null || true
  sleep 2
  # Force kill if still alive
  if pgrep -f "/bin/hermes" >/dev/null 2>&1; then
    pkill -9 -f "/bin/hermes" 2>/dev/null || true
    sleep 1
  fi
  success "Old hermes process stopped 旧 hermes 进程已停止"
fi

sleep 1

# Start daemon via Python (same path hermes uses)
info "Starting memory daemon..."
daemon_result=$("$hermes_python" -c "
import sys
sys.path.insert(0, '$ADAPTER_DIR')
from daemon_manager import ensure_daemon
info = ensure_daemon()
print(info.get('viewerUrl', ''))
" 2>&1) || true

VIEWER_URL=$(echo "$daemon_result" | tail -1)

if [[ -n "$VIEWER_URL" && "$VIEWER_URL" == http* ]]; then
  success "Memory daemon started"
  success "Memory Viewer: $VIEWER_URL"
else
  warn "Daemon auto-start returned: $daemon_result"
  warn "The daemon will start automatically when you run 'hermes chat'"
  VIEWER_URL="http://127.0.0.1:18901"
fi

# Final verify
sleep 2
if curl -s "$VIEWER_URL" >/dev/null 2>&1; then
  success "Memory viewer is accessible at $VIEWER_URL"
else
  info "Memory viewer will be available at $VIEWER_URL after running hermes chat"
fi

# ═══════════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════════

echo ""
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}  ✨ Installation complete! 安装完成!${NC}"
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Memory Viewer:${NC}  $VIEWER_URL"
echo -e "  ${BOLD}Plugin Dir:${NC}     $INSTALL_DIR"
echo ""
if $HERMES_WAS_RUNNING; then
  echo -e "  ${YELLOW}⚠ Hermes was stopped to apply new config.${NC}"
  echo -e "  ${YELLOW}  hermes 已被停止以应用新配置。${NC}"
  echo ""
fi
echo -e "  ${BOLD}开始使用 / Get started:${NC}"
echo -e "    ${BOLD}hermes chat${NC}"
echo ""
echo -e "  ${DIM}The memory panel opens automatically when hermes starts.${NC}"
echo -e "  ${DIM}记忆面板会在 hermes 启动时自动打开。${NC}"
echo ""
