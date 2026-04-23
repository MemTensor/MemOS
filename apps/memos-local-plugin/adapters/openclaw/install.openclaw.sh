#!/usr/bin/env bash
# install.openclaw.sh — adapter-specific step of install.sh.
#
# The top-level installer has already copied the plugin source to
# $PREFIX and prepared $HOME_DIR. Here we handle the two OpenClaw-
# specific bits:
#
#   1. Install node_modules inside $PREFIX (one-time, idempotent).
#   2. Build the viewer + site bundles so the HTTP server has static
#      assets to serve.
#
# We never touch the OpenClaw host process itself — the plugin loads
# on demand when the host's plugin manager discovers $PREFIX.

set -euo pipefail

: "${AGENT:?install.openclaw.sh expects AGENT to be set by the parent installer}"
: "${PREFIX:?install.openclaw.sh expects PREFIX to be set by the parent installer}"
: "${HOME_DIR:?install.openclaw.sh expects HOME_DIR to be set by the parent installer}"

log() { printf "\033[1;36m[install:openclaw]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[install:openclaw]\033[0m %s\n" "$*" >&2; }

cd "$PREFIX"

# ── 1. node_modules ───────────────────────────────────────────────────────────
if command -v npm >/dev/null 2>&1; then
  if [[ -d "node_modules" ]]; then
    log "node_modules already present — skipping install (re-run with CLEAN=1 to wipe)"
  else
    log "Installing npm dependencies (this can take a minute)…"
    npm install --no-audit --no-fund --prefer-offline
  fi
else
  warn "npm not found on PATH; skipping dependency install. The plugin will not run until you provide node_modules."
fi

# ── 2. viewer + site bundles ──────────────────────────────────────────────────
if [[ -x "./node_modules/.bin/vite" ]]; then
  log "Building viewer bundle → web/dist/"
  ./node_modules/.bin/vite build --config vite.config.ts >/dev/null
  log "Building site bundle → site/dist/"
  ( cd site && ../node_modules/.bin/vite build >/dev/null )
else
  warn "vite not found in node_modules; skipping bundle build"
fi

log "OpenClaw adapter install complete."
log "  Plugin code:   $PREFIX"
log "  Runtime data:  $HOME_DIR"
log "  Viewer:        http://127.0.0.1:18910/"
log "  Site:          http://127.0.0.1:18910/site/"
