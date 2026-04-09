#!/usr/bin/env bash
set -euo pipefail

# ─── MemTensor Memory Plugin installer for OpenHarness ───
#
# Usage:
#   bash install.sh
#
# Prerequisites:
#   - Node.js >= 18
#   - Python 3.10+
#   - OpenHarness installed

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MEMOS_OPENCLAW_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

OH_CONFIG_DIR="${OPENHARNESS_CONFIG_DIR:-$HOME/.openharness}"
PLUGIN_DIR="$OH_CONFIG_DIR/plugins/memos-memory"

echo "=== MemTensor Memory Plugin Installer ==="
echo ""
echo "Plugin source:  $SCRIPT_DIR"
echo "OpenClaw core:  $MEMOS_OPENCLAW_DIR"
echo "Install target: $PLUGIN_DIR"
echo ""

# ─── Pre-flight checks ───

if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required (>= 18). Please install it first."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 is required. Current: $(node -v)"
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "ERROR: Python 3 is required. Please install it first."
  exit 1
fi

echo "✓ Node.js $(node -v)"
echo "✓ Python $(python3 --version)"

# ─── Install memos-local-openclaw dependencies ───

echo ""
echo "Installing memos-local-openclaw dependencies..."
cd "$MEMOS_OPENCLAW_DIR"

if command -v pnpm &>/dev/null; then
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
elif command -v npm &>/dev/null; then
  npm install
else
  echo "ERROR: npm or pnpm is required."
  exit 1
fi

echo "✓ Dependencies installed"

# ─── Copy plugin to OpenHarness plugins directory ───

echo ""
echo "Installing plugin to $PLUGIN_DIR..."
mkdir -p "$PLUGIN_DIR"

cp "$SCRIPT_DIR/plugin.json" "$PLUGIN_DIR/"
cp -r "$SCRIPT_DIR/skills" "$PLUGIN_DIR/"
cp -r "$SCRIPT_DIR/scripts" "$PLUGIN_DIR/"

# ─── Generate hooks.json with absolute paths ───

SCRIPTS_ABS="$PLUGIN_DIR/scripts"
cat > "$PLUGIN_DIR/hooks.json" <<HOOKS_EOF
{
  "session_start": [
    {
      "type": "command",
      "command": "python3 $SCRIPTS_ABS/recall.py",
      "timeout_seconds": 60
    }
  ],
  "session_end": [
    {
      "type": "command",
      "command": "python3 $SCRIPTS_ABS/capture.py",
      "timeout_seconds": 30
    }
  ]
}
HOOKS_EOF

echo "✓ hooks.json generated"

# ─── Record bridge path for runtime discovery ───

BRIDGE_CTS="$MEMOS_OPENCLAW_DIR/bridge.cts"
echo "$BRIDGE_CTS" > "$SCRIPTS_ABS/bridge_path.txt"

if [ -f "$BRIDGE_CTS" ]; then
  echo "✓ Bridge script found: $BRIDGE_CTS"
else
  echo "WARNING: bridge.cts not found at $BRIDGE_CTS"
  echo "  Make sure it exists before using the plugin."
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "The plugin is now at: $PLUGIN_DIR"
echo ""
echo "How it works:"
echo "  • On session_start: the daemon (bridge + memory viewer) starts automatically"
echo "  • Memory Viewer will be available at http://127.0.0.1:18899"
echo "  • Memories are recalled and injected into the system prompt"
echo "  • On session_end: conversation is captured into the memory store"
echo ""
echo "Optional environment variables:"
echo "  MEMOS_STATE_DIR          - Override memory database location"
echo "  MEMOS_DAEMON_PORT        - Bridge daemon TCP port (default: 18990)"
echo "  MEMOS_VIEWER_PORT        - Memory viewer HTTP port (default: 18899)"
echo "  MEMOS_EMBEDDING_PROVIDER - Embedding provider (default: local)"
echo "  MEMOS_EMBEDDING_API_KEY  - API key for embedding provider"
echo "  MEMOS_EMBEDDING_ENDPOINT - Custom embedding endpoint"
