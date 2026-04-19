#!/usr/bin/env bash
# start-memos.sh — Decrypt secrets, load env, start MemOS server
# Usage: ./start-memos.sh [--port 8001]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGE_KEY="${MEMOS_AGE_KEY:-$HOME/.memos/keys/memos.key}"
SECRETS_ENC="${MEMOS_SECRETS:-$HOME/.memos/secrets.env.age}"
AGE_BIN="${AGE_BIN:-$(command -v age || echo /home/linuxbrew/.linuxbrew/bin/age)}"
PORT="${1:-8001}"

# 1. Load base .env (non-secret config)
set -a
source "$SCRIPT_DIR/.env"
set +a

# 2. Decrypt and load secrets
if [[ -f "$SECRETS_ENC" ]]; then
    if [[ ! -f "$AGE_KEY" ]]; then
        echo "ERROR: age key not found at $AGE_KEY" >&2
        exit 1
    fi
    echo "Decrypting secrets from $SECRETS_ENC ..."
    eval "$("$AGE_BIN" -d -i "$AGE_KEY" "$SECRETS_ENC" | grep -v '^#' | grep '=' | sed 's/^/export /')"
    echo "Secrets loaded."
else
    echo "WARNING: No encrypted secrets file at $SECRETS_ENC — using env as-is" >&2
fi

# 3. Start server
echo "Starting MemOS on port $PORT ..."
exec python3.12 -m memos.api.server_api --port "$PORT"
