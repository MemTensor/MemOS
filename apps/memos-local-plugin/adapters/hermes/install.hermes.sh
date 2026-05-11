#!/usr/bin/env bash
# install.hermes.sh — adapter-specific step of install.sh.
#
# The parent installer has already copied the plugin source to
# $PREFIX and prepared $HOME_DIR. Here we handle the Hermes-specific
# extras:
#
#   1. Install node_modules inside $PREFIX (idempotent).
#   2. Build the viewer + site bundles so the HTTP server has static
#      assets available.
#   3. Symlink the Python memos_provider package into the Hermes
#      plugins directory so `from memos_provider import MemTensorProvider`
#      resolves from Hermes without extra path munging.
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
  log "Building viewer bundle → web/dist/"
  ./node_modules/.bin/vite build --config vite.config.ts >/dev/null
else
  warn "vite not found in node_modules; skipping bundle build"
fi

# ── 3. wire up Python provider ────────────────────────────────────────────────
# Hermes discovers providers from $PREFIX. Symlinking the Python package
# to a discoverable path (if HERMES_PLUGINS_DIR is set) avoids asking the
# user to edit PYTHONPATH manually.
if [[ -n "${HERMES_PLUGINS_DIR:-}" ]]; then
  mkdir -p "$HERMES_PLUGINS_DIR"
  ln -sfn "$PREFIX/adapters/hermes/memos_provider" "$HERMES_PLUGINS_DIR/memos_provider"
  log "Linked Python provider → $HERMES_PLUGINS_DIR/memos_provider"
else
  log "HERMES_PLUGINS_DIR not set; skipping Python provider symlink. You can manually link:"
  log "  ln -s \"$PREFIX/adapters/hermes/memos_provider\" <hermes-plugins>/memos_provider"
fi

log "Hermes adapter install complete."
log "  Plugin code:   $PREFIX"
log "  Runtime data:  $HOME_DIR"
log "  Viewer:        http://127.0.0.1:18910/"
log "  Site:          http://127.0.0.1:18910/site/"
