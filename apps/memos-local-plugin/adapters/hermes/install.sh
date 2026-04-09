#!/usr/bin/env bash
set -euo pipefail

# ─── MemTensor Memory Plugin installer for hermes-agent ───
#
# Usage:
#   bash install.sh [/path/to/hermes-agent]
#
# Prerequisites:
#   - Node.js >= 18
#   - hermes-agent repository cloned locally

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

echo "=== MemTensor Memory Plugin Installer (hermes-agent) ==="
echo ""
echo "Plugin source:  $SCRIPT_DIR"
echo "Plugin root:    $MEMOS_PLUGIN_DIR"
echo "Hermes repo:    $HERMES_REPO"
echo "Install target: $TARGET_DIR"
echo ""

# ─── Pre-flight checks ───

if [ ! -f "$HERMES_REPO/agent/memory_provider.py" ]; then
  echo "ERROR: $HERMES_REPO does not look like a hermes-agent repository."
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required (>= 18). Please install it first."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 is required. Current: $(node -v)"
  exit 1
fi

echo "✓ Node.js $(node -v)"

# ─── Install plugin dependencies ───

echo ""
echo "Installing plugin dependencies..."
cd "$MEMOS_PLUGIN_DIR"

if command -v pnpm &>/dev/null; then
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
elif command -v npm &>/dev/null; then
  npm install
else
  echo "ERROR: npm or pnpm is required."
  exit 1
fi

echo "✓ Dependencies installed"

# ─── Record bridge path for runtime discovery ───

BRIDGE_CTS="$MEMOS_PLUGIN_DIR/bridge.cts"
echo "$BRIDGE_CTS" > "$SCRIPT_DIR/bridge_path.txt"

if [ -f "$BRIDGE_CTS" ]; then
  echo "✓ Bridge script found: $BRIDGE_CTS"
else
  echo "WARNING: bridge.cts not found at $BRIDGE_CTS"
  echo "  Make sure it exists before using the plugin."
fi

# ─── Create symlink in hermes-agent plugins/memory/ ───

echo ""
echo "Creating symlink: $TARGET_DIR -> $SCRIPT_DIR"

if [ -L "$TARGET_DIR" ]; then
  rm "$TARGET_DIR"
  echo "  (removed old symlink)"
elif [ -d "$TARGET_DIR" ]; then
  rm -rf "$TARGET_DIR"
  echo "  (removed old directory)"
fi

ln -s "$SCRIPT_DIR" "$TARGET_DIR"
echo "✓ Symlink created"

echo ""
echo "=== Installation complete ==="
echo ""
echo "Activate the plugin by editing ~/.hermes/config.yaml:"
echo ""
echo "  memory:"
echo "    provider: memtensor"
echo ""
echo "Then start hermes normally. The bridge daemon and memory viewer"
echo "will start automatically on first session."
echo ""
echo "  Memory Viewer: http://127.0.0.1:18901"
echo ""
echo "Optional environment variables:"
echo "  MEMOS_STATE_DIR          - Override memory database location"
echo "  MEMOS_DAEMON_PORT        - Bridge daemon TCP port (default: 18990)"
echo "  MEMOS_VIEWER_PORT        - Memory viewer HTTP port (default: 18899)"
echo "  MEMOS_EMBEDDING_PROVIDER - Embedding provider (default: local)"
echo "  MEMOS_EMBEDDING_API_KEY  - API key for embedding provider"
echo "  MEMOS_EMBEDDING_ENDPOINT - Custom embedding endpoint"
