#!/usr/bin/env bash
set -Eeuo pipefail

AGENT="auto" # auto | openclaw | hermes | all
INSTALL_DEPS="1"
# Avoid downloading CUDA/GPU binaries for onnxruntime-node during local installs.
# Override before running if you really want CUDA binaries, e.g.
#   ONNXRUNTIME_NODE_INSTALL_CUDA=v12 ./local-pack-install.sh
ONNXRUNTIME_NODE_INSTALL_CUDA="${ONNXRUNTIME_NODE_INSTALL_CUDA:-skip}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent|--target)
      AGENT="${2:-}"
      shift 2
      ;;
    --no-install-deps)
      INSTALL_DEPS="0"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--agent auto|openclaw|hermes|all] [--no-install-deps]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

case "$AGENT" in
  auto|openclaw|hermes|all) ;;
  *)
    echo "--agent must be one of: auto, openclaw, hermes, all" >&2
    exit 1
    ;;
esac

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

[[ -f package.json ]] || { echo "package.json not found in $PROJECT_DIR" >&2; exit 1; }
[[ -f install.sh ]] || { echo "install.sh not found in $PROJECT_DIR" >&2; exit 1; }

export ONNXRUNTIME_NODE_INSTALL_CUDA
export npm_config_onnxruntime_node_install_cuda="$ONNXRUNTIME_NODE_INSTALL_CUDA"

if [[ "$INSTALL_DEPS" == "1" ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

PACK_DIR="$PROJECT_DIR/.local-npm-packages"
mkdir -p "$PACK_DIR"

echo "Building local npm package..."
PACK_OUTPUT="$(npm pack --pack-destination "$PACK_DIR" --loglevel=error)"
TARBALL_NAME="$(printf '%s\n' "$PACK_OUTPUT" | awk 'NF { last=$0 } END { print last }')"
TARBALL="$PACK_DIR/$TARBALL_NAME"

[[ -f "$TARBALL" ]] || { echo "npm pack failed: tarball not found: $TARBALL" >&2; exit 1; }

echo "Local package created: $TARBALL"
echo "Installing plugin from local package..."

bash "$PROJECT_DIR/install.sh" --version "$TARBALL" --agent "$AGENT"
