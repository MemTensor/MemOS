#!/usr/bin/env bash
# install.hermes.sh — adapter-specific step of install.sh.
#
# The parent installer has already copied the plugin source to
# $PREFIX and prepared $HOME_DIR. Here we handle the Hermes-specific
# extras:
#
#   1. Install node_modules inside $PREFIX (idempotent).
#   2. Build the viewer bundle so the HTTP server has static assets
#      available.
#   3. Symlink the Python memos_provider package into Hermes' durable
#      user-plugin directory, with an optional legacy source-tree link
#      when HERMES_PLUGINS_DIR is supplied.
#
# We never modify the Hermes host process — its plugin manager picks
# up $PREFIX on next start.

set -euo pipefail

: "${AGENT:?install.hermes.sh expects AGENT to be set by the parent installer}"
: "${PREFIX:?install.hermes.sh expects PREFIX to be set by the parent installer}"
: "${HOME_DIR:?install.hermes.sh expects HOME_DIR to be set by the parent installer}"

log() { printf "\033[1;36m[install:hermes]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[install:hermes]\033[0m %s\n" "$*" >&2; }

cd "$PREFIX"

# ── 1. node_modules ───────────────────────────────────────────────────────────
if command -v npm >/dev/null 2>&1; then
  command -v node > .memos-node-bin
  if [[ -d "node_modules" ]]; then
    log "node_modules already present — skipping install"
  else
    log "Installing npm dependencies (this can take a minute)…"
    npm install --no-audit --no-fund --prefer-offline
  fi
else
  warn "npm not found on PATH; bridge.cts requires Node.js ≥ 20."
fi

# ── 2. viewer bundle ──────────────────────────────────────────────────────────
if [[ -x "./node_modules/.bin/vite" ]]; then
  log "Building viewer bundle → viewer/dist/"
  ./node_modules/.bin/vite build --config vite.config.ts >/dev/null
else
  warn "vite not found in node_modules; skipping bundle build"
fi

# ── 3. wire up Python provider ────────────────────────────────────────────────
# Hermes upgrades can replace ~/.hermes/hermes-agent, so the primary link lives
# in the user-owned plugin directory. The legacy source-tree link is still
# written when the caller exposes it for older Hermes builds.
provider_source="$PREFIX/adapters/hermes/memos_provider"
user_plugins_dir="${HERMES_USER_PLUGINS_DIR:-$HOME/.hermes/plugins}"
mkdir -p "$user_plugins_dir"
ln -sfn "$provider_source" "$user_plugins_dir/memtensor"
cp "$PREFIX/adapters/hermes/plugin.yaml" "$provider_source/plugin.yaml" 2>/dev/null || true
log "Linked durable Python provider → $user_plugins_dir/memtensor"

if [[ -n "${HERMES_PLUGINS_DIR:-}" ]]; then
  mkdir -p "$HERMES_PLUGINS_DIR"
  ln -sfn "$provider_source" "$HERMES_PLUGINS_DIR/memtensor"
  log "Linked legacy Python provider → $HERMES_PLUGINS_DIR/memtensor"
fi

log "Hermes adapter install complete."
log "  Plugin code:   $PREFIX"
log "  Runtime data:  $HOME_DIR"
log "  Viewer:        http://127.0.0.1:18910/"
