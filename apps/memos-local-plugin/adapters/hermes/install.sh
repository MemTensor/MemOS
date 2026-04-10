#!/usr/bin/env bash
set -euo pipefail

# ─── MemTensor Memory Plugin installer for hermes-agent ───
#
# Usage:
#   bash install.sh [/path/to/hermes-agent]
#
# Prerequisites:
#   - hermes-agent repository cloned locally
#   - Node.js >= 18 (auto-installed if missing)

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLUE}$1${NC}"; }
success() { echo -e "${GREEN}$1${NC}"; }
warn()    { echo -e "${YELLOW}$1${NC}"; }
error()   { echo -e "${RED}$1${NC}"; }

# ─── Node.js auto-install helpers ───

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
      error "Homebrew is required to auto-install Node.js on macOS"
      error "Install Homebrew first: https://brew.sh"
      exit 1
    fi
    info "Auto-installing Node.js 22 via Homebrew..."
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
    info "Auto-installing Node.js 22 on Linux..."
    local tmp_script
    tmp_script="$(mktemp)"
    if command -v apt-get >/dev/null 2>&1; then
      if ! download_to_file "https://deb.nodesource.com/setup_22.x" "$tmp_script"; then
        error "Failed to download NodeSource setup script"
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
        error "Failed to download NodeSource setup script"
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
        error "Failed to download NodeSource setup script"
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

  error "Unsupported platform for auto-install. Please install Node.js >= 18 manually."
  exit 1
}

ensure_node() {
  local required_major=18
  local current_major
  current_major="$(node_major_version)"

  if [[ "$current_major" =~ ^[0-9]+$ ]] && (( current_major >= required_major )); then
    success "✓ Node.js $(node -v)"
    return 0
  fi

  warn "Node.js >= ${required_major} is required but not found. Auto-installing..."
  install_node22

  current_major="$(node_major_version)"
  if [[ "$current_major" =~ ^[0-9]+$ ]] && (( current_major >= required_major )); then
    success "✓ Node.js installed: $(node -v)"
    return 0
  fi

  error "Node.js installation failed — still below >= ${required_major}."
  exit 1
}

# ─── Main ───

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MEMOS_PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# hermes-agent location: first argument or auto-detect
# Priority: CLI arg > hermes runtime dir > repo clone
if [ -n "${1:-}" ]; then
  HERMES_REPO="$(cd "$1" && pwd)"
elif [ -d "$HOME/.hermes/hermes-agent/plugins/memory" ]; then
  HERMES_REPO="$HOME/.hermes/hermes-agent"
elif [ -d "$HOME/MyProject/hermes-agent" ]; then
  HERMES_REPO="$HOME/MyProject/hermes-agent"
else
  echo "Usage: bash install.sh /path/to/hermes-agent"
  echo "  Could not auto-detect hermes-agent location."
  exit 1
fi

TARGET_DIR="$HERMES_REPO/plugins/memory/memtensor"

echo -e "${BOLD}=== MemTensor Memory Plugin Installer (hermes-agent) ===${NC}"
echo ""
info "Plugin source:  $SCRIPT_DIR"
info "Plugin root:    $MEMOS_PLUGIN_DIR"
info "Hermes repo:    $HERMES_REPO"
info "Install target: $TARGET_DIR"
echo ""

# ─── Pre-flight checks ───

if [ ! -f "$HERMES_REPO/agent/memory_provider.py" ]; then
  error "ERROR: $HERMES_REPO does not look like a hermes-agent repository."
  exit 1
fi

ensure_node

# ─── Install plugin dependencies ───

echo ""
info "Installing plugin dependencies..."
cd "$MEMOS_PLUGIN_DIR"

if command -v pnpm &>/dev/null; then
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
elif command -v npm &>/dev/null; then
  npm install
else
  error "ERROR: npm or pnpm is required."
  exit 1
fi

success "✓ Dependencies installed"

# ─── Record bridge path for runtime discovery ───

BRIDGE_CTS="$MEMOS_PLUGIN_DIR/bridge.cts"
echo "$BRIDGE_CTS" > "$SCRIPT_DIR/bridge_path.txt"

if [ -f "$BRIDGE_CTS" ]; then
  success "✓ Bridge script found: $BRIDGE_CTS"
else
  warn "WARNING: bridge.cts not found at $BRIDGE_CTS"
  warn "  Make sure it exists before using the plugin."
fi

# ─── Create symlink in hermes-agent plugins/memory/ ───

echo ""
info "Creating symlink: $TARGET_DIR -> $SCRIPT_DIR"

if [ -L "$TARGET_DIR" ]; then
  rm "$TARGET_DIR"
  info "  (removed old symlink)"
elif [ -d "$TARGET_DIR" ]; then
  rm -rf "$TARGET_DIR"
  info "  (removed old directory)"
fi

ln -s "$SCRIPT_DIR" "$TARGET_DIR"
success "✓ Symlink created"

echo ""
echo -e "${BOLD}=== Installation complete ===${NC}"
echo ""
info "Activate the plugin by editing ~/.hermes/config.yaml:"
echo ""
echo "  memory:"
echo "    provider: memtensor"
echo ""
info "Then start hermes normally. The bridge daemon and memory viewer"
info "will start automatically on first session."
echo ""
success "  Memory Viewer: http://127.0.0.1:18901"
echo ""
info "Optional environment variables:"
echo "  MEMOS_STATE_DIR          - Override memory database location"
echo "  MEMOS_DAEMON_PORT        - Bridge daemon TCP port (default: 18990)"
echo "  MEMOS_VIEWER_PORT        - Memory viewer HTTP port (default: 18899)"
echo "  MEMOS_EMBEDDING_PROVIDER - Embedding provider (default: local)"
echo "  MEMOS_EMBEDDING_API_KEY  - API key for embedding provider"
echo "  MEMOS_EMBEDDING_ENDPOINT - Custom embedding endpoint"
