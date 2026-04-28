#!/usr/bin/env bash
# install.sh — one-command installer for @memtensor/memos-local-plugin.
#
# Usage:
#   bash install.sh                        # install latest from npm
#   bash install.sh --version 2.0.0        # install specific npm version
#   bash install.sh --version ./pkg.tgz    # use a local tarball
#
# Interactive: with a TTY we ask where to install (OpenClaw / Hermes /
# both). Press ENTER for auto-detect. Non-TTY falls straight to
# auto-detect. macOS + Linux only.
#
# Design notes:
#   - Each agent runs its OWN viewer on its OWN well-known port:
#       openclaw → :18799
#       hermes   → :18800
#     Ports are intentionally fixed and not configurable by the
#     installer — having two agents share one port (the previous
#     "hub/peer" model) caused too many sharp edges (read-only
#     panels, dropped writes, mid-session ownership flips). Picking
#     a port at install time would also raise the question of
#     "which agent does this port belong to?" — we'd rather not
#     have that conversation.
#   - Each agent keeps its own SQLite DB under `~/.<agent>/memos-plugin/`.
#     There is no cross-agent memory in one UI; if both are installed
#     the root path on either viewer shows a small picker that links
#     to the other agent's port.
#   - All install logic is self-contained: Node bootstrap, tarball
#     resolution, better-sqlite3 rebuild, config patching, gateway
#     restart, viewer-readiness wait. No separate sub-scripts.

set -euo pipefail

# ─── Colors ────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()    { printf "  ${BLUE}›${NC} %b\n" "$*"; }
success() { printf "  ${GREEN}✔${NC} %b\n" "$*"; }
warn()    { printf "  ${YELLOW}⚠${NC}  %b\n" "$*" >&2; }
error()   { printf "  ${RED}✘${NC} %b\n" "$*" >&2; }
die()     { error "$*"; exit 1; }

header() {
  local text="$*"
  local pad_total=$((46 - ${#text}))
  (( pad_total < 0 )) && pad_total=0
  local padding=""
  local i; for ((i=0; i<pad_total; i++)); do padding+=" "; done
  echo
  printf "  ${BOLD}${BLUE}┌──────────────────────────────────────────────────┐${NC}\n"
  printf "  ${BOLD}${BLUE}│${NC}  ${BOLD}%s${NC}%s  ${BOLD}${BLUE}│${NC}\n" "${text}" "${padding}"
  printf "  ${BOLD}${BLUE}└──────────────────────────────────────────────────┘${NC}\n"
  echo
}

STEP_CURRENT=0
step() {
  STEP_CURRENT=$((STEP_CURRENT + 1))
  printf "  ${BOLD}${CYAN}[%d]${NC} %s\n" "${STEP_CURRENT}" "$*"
}

banner() {
  local ver="${VERSION_ARG:-latest}"
  echo
  printf "  ${BOLD}${BLUE}┌──────────────────────────────────────────────────┐${NC}\n"
  printf "  ${BOLD}${BLUE}│${NC}                                                  ${BOLD}${BLUE}│${NC}\n"
  printf "  ${BOLD}${BLUE}│${NC}   🧠  ${BOLD}MemOS Local Plugin Installer${NC}               ${BOLD}${BLUE}│${NC}\n"
  printf "  ${BOLD}${BLUE}│${NC}                                                  ${BOLD}${BLUE}│${NC}\n"
  printf "  ${BOLD}${BLUE}└──────────────────────────────────────────────────┘${NC}\n"
  printf "  ${DIM}Package: ${NPM_PACKAGE}  ·  Version: ${ver}${NC}\n"
  echo
}

# ─── Constants ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
PLUGIN_ID="memos-local-plugin"
NPM_PACKAGE="@memtensor/memos-local-plugin"
# Per-agent viewer ports are fixed (see header design notes).
OPENCLAW_PORT="18799"
HERMES_PORT="18800"
REQUIRED_NODE_MAJOR=20
# Older plugin IDs disabled on install so they don't fight for the
# memory slot. We never touch the old plugin's data.
LEGACY_PLUGIN_IDS=("memos-local-openclaw-plugin")

# ─── Args — one flag, period ──────────────────────────────────────────────
VERSION_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION_ARG="${2:-}"; shift 2 ;;
    --port)
      die "--port is no longer supported. Each agent uses a fixed port: \
openclaw → :${OPENCLAW_PORT}, hermes → :${HERMES_PORT}." ;;
    -h|--help)
      cat <<EOF
Usage:
  bash install.sh                     # latest from npm
  bash install.sh --version X.Y.Z     # specific npm version
  bash install.sh --version ./pkg.tgz # local tarball

Each agent runs its viewer on a fixed port:
  openclaw → http://127.0.0.1:${OPENCLAW_PORT}
  hermes   → http://127.0.0.1:${HERMES_PORT}
EOF
      exit 0
      ;;
    *) die "Unknown argument: $1 (only --version is supported)" ;;
  esac
done

# ─── Platform ─────────────────────────────────────────────────────────────
OS_NAME="$(uname -s)"
case "${OS_NAME}" in
  Darwin|Linux) ;;
  *) die "Unsupported platform: ${OS_NAME}. macOS and Linux only." ;;
esac

# ─── Node bootstrap ───────────────────────────────────────────────────────
node_major() {
  command -v node >/dev/null 2>&1 || { echo "0"; return; }
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

download_to_file() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then curl -fsSL "${url}" -o "${out}"; return $?; fi
  if command -v wget >/dev/null 2>&1; then wget -q "${url}" -O "${out}"; return $?; fi
  return 1
}

run_with_privilege() {
  if [[ "$(id -u)" -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

install_node_mac() {
  command -v brew >/dev/null 2>&1 || die "Homebrew required on macOS. Install https://brew.sh first."
  info "Installing Node.js 22 via Homebrew..."
  brew install node@22 >/dev/null
  brew link node@22 --overwrite --force >/dev/null 2>&1 || true
  local p; p="$(brew --prefix node@22 2>/dev/null || true)"
  [[ -n "${p}" && -x "${p}/bin/node" ]] && export PATH="${p}/bin:${PATH}"
}

install_node_linux() {
  local tmp installer url
  tmp="$(mktemp)"
  if command -v apt-get >/dev/null 2>&1; then
    installer="apt"; url="https://deb.nodesource.com/setup_22.x"
  elif command -v dnf >/dev/null 2>&1; then
    installer="dnf"; url="https://rpm.nodesource.com/setup_22.x"
  elif command -v yum >/dev/null 2>&1; then
    installer="yum"; url="https://rpm.nodesource.com/setup_22.x"
  else
    die "No supported package manager. Install Node.js ≥ ${REQUIRED_NODE_MAJOR} manually."
  fi
  info "Installing Node.js 22 via ${installer}..."
  download_to_file "${url}" "${tmp}" || die "Failed to download Node setup script."
  run_with_privilege bash "${tmp}"
  case "${installer}" in
    apt) run_with_privilege apt-get update -qq && run_with_privilege apt-get install -y -qq nodejs ;;
    dnf) run_with_privilege dnf install -y -q nodejs ;;
    yum) run_with_privilege yum install -y -q nodejs ;;
  esac
  rm -f "${tmp}"
}

ensure_node() {
  local current; current="$(node_major)"
  if ! [[ "${current}" =~ ^[0-9]+$ ]] || (( current < REQUIRED_NODE_MAJOR )); then
    warn "Node.js >= ${REQUIRED_NODE_MAJOR} required (have ${current}). Auto-installing..."
    case "${OS_NAME}" in
      Darwin) install_node_mac ;;
      Linux)  install_node_linux ;;
    esac
    current="$(node_major)"
    [[ "${current}" =~ ^[0-9]+$ ]] && (( current >= REQUIRED_NODE_MAJOR )) \
      || die "Node.js install failed. Install ≥ ${REQUIRED_NODE_MAJOR} and re-run."
  fi

  # Node 25+ has no better-sqlite3 prebuilts → must compile. Warn the
  # user (but don't block; the rebuild step below tries regardless).
  if (( current >= 25 )); then
    warn "Node $(node -v) — no better-sqlite3 prebuild available, will compile from source."
    printf "       ${DIM}Tip: switch to Node LTS for prebuilt binaries:  nvm install 22${NC}\n" >&2
  fi
  success "Node.js $(node -v)"
}

# ─── Detect hosts ─────────────────────────────────────────────────────────
HAS_OPENCLAW="false"
HAS_HERMES="false"
[[ -d "${HOME}/.openclaw" ]] && HAS_OPENCLAW="true"
[[ -d "${HOME}/.hermes"   ]] && HAS_HERMES="true"

find_openclaw_cli() {
  command -v openclaw 2>/dev/null && return 0
  [[ -x "${HOME}/.local/bin/openclaw" ]] && { echo "${HOME}/.local/bin/openclaw"; return 0; }
  return 1
}

# ─── Interactive picker ───────────────────────────────────────────────────
AGENT_SELECTION=""
pick_agents_interactively() {
  echo
  printf "  ${BOLD}Detected agents:${NC}\n"
  if [[ "${HAS_OPENCLAW}" == "true" ]]; then
    printf "    ${GREEN}●${NC}  OpenClaw   ${DIM}~/.openclaw${NC}\n"
  else
    printf "    ${DIM}○  OpenClaw   (not installed)${NC}\n"
  fi
  if [[ "${HAS_HERMES}" == "true" ]]; then
    printf "    ${GREEN}●${NC}  Hermes     ${DIM}~/.hermes${NC}\n"
  else
    printf "    ${DIM}○  Hermes     (not installed)${NC}\n"
  fi
  echo
  local choice
  if [[ ! -t 0 ]]; then
    info "Non-interactive mode — auto-detecting agents"
    choice=""
  else
    printf "  ${BOLD}Install into which agent?${NC}\n\n"
    printf "    ${DIM}[Enter]${NC}  🔍  Auto-detect\n"
    printf "        ${DIM}[1]${NC}  🦞  OpenClaw only\n"
    printf "        ${DIM}[2]${NC}  👩  Hermes only\n"
    printf "        ${DIM}[3]${NC}  📦  Both\n"
    printf "        ${DIM}[q]${NC}  🚪  Quit\n"
    echo
    printf "  Choice: "
    read -r choice || choice=""
  fi
  case "${choice}" in
    "")  AGENT_SELECTION="auto" ;;
    1)   AGENT_SELECTION="openclaw" ;;
    2)   AGENT_SELECTION="hermes" ;;
    3)   AGENT_SELECTION="all" ;;
    q|Q) info "Aborted."; exit 0 ;;
    *)   die "Invalid choice: ${choice}" ;;
  esac
}

# ─── Resolve tarball ──────────────────────────────────────────────────────
BUILT_TARBALL=""
STAGE_DIR=""
SOURCE_KIND=""   # "path" for a local file, "npm" otherwise
SOURCE_SPEC=""

resolve_tarball() {
  STAGE_DIR="$(mktemp -d)"
  trap 'rm -rf "${STAGE_DIR}"' EXIT

  if [[ -n "${VERSION_ARG}" && -f "${VERSION_ARG}" ]]; then
    BUILT_TARBALL="$(cd "$(dirname "${VERSION_ARG}")" && pwd)/$(basename "${VERSION_ARG}")"
    SOURCE_KIND="path"
    SOURCE_SPEC="${BUILT_TARBALL}"
    success "Using local tarball: ${BUILT_TARBALL}"
    return 0
  fi

  local spec
  if [[ -z "${VERSION_ARG}" ]]; then
    spec="${NPM_PACKAGE}"
    info "Downloading latest ${NPM_PACKAGE} from npm …"
  else
    spec="${NPM_PACKAGE}@${VERSION_ARG}"
    info "Downloading ${spec} from npm …"
  fi
  SOURCE_KIND="npm"
  SOURCE_SPEC="${spec}"

  (cd "${STAGE_DIR}" && npm pack "${spec}" --loglevel=error >/dev/null 2>&1)
  BUILT_TARBALL="$(ls "${STAGE_DIR}"/*.tgz 2>/dev/null | head -1)"
  [[ -n "${BUILT_TARBALL}" && -f "${BUILT_TARBALL}" ]] \
    || die "npm pack failed for ${spec}. Check the npm registry or pass a local path via --version ./pkg.tgz"
  success "Package ready: $(basename "${BUILT_TARBALL}")"
}

# ─── Deploy tarball into a prefix + rebuild native deps ───────────────────
#
# Hermes's layout puts the plugin source AND the runtime home in the same
# directory (${HOME}/.hermes/memos-plugin/). That means data/memos.db,
# config.yaml, logs/, skills/, daemon/, .auth.json all live next to the
# source files the tarball ships. A naive `rm -rf ${prefix}` would wipe
# the user's memory DB on every re-install.
#
# We mitigate that by preserving a well-known allowlist of user-data
# artefacts across the rm/extract cycle. node_modules is preserved too
# so npm install stays fast on re-install.
deploy_tarball_to_prefix() {
  local prefix="$1"
  step "Deploying to ${prefix}"
  local saved_dir=""
  local preserve=(node_modules data logs skills daemon config.yaml .auth.json)
  if [[ -d "${prefix}" ]]; then
    saved_dir="$(mktemp -d)"
    local item
    for item in "${preserve[@]}"; do
      if [[ -e "${prefix}/${item}" ]]; then
        mkdir -p "$(dirname "${saved_dir}/${item}")"
        mv "${prefix}/${item}" "${saved_dir}/${item}"
      fi
    done
    rm -rf "${prefix}"
    mkdir -p "${prefix}"
    tar xzf "${BUILT_TARBALL}" -C "${prefix}" --strip-components=1
    for item in "${preserve[@]}"; do
      if [[ -e "${saved_dir}/${item}" ]]; then
        rm -rf "${prefix}/${item}"
        mv "${saved_dir}/${item}" "${prefix}/${item}"
      fi
    done
    rm -rf "${saved_dir}"
  else
    mkdir -p "${prefix}"
    tar xzf "${BUILT_TARBALL}" -C "${prefix}" --strip-components=1
  fi
  [[ -f "${prefix}/package.json" ]] || die "Extraction failed: ${prefix}/package.json missing"
  success "Package extracted"

  step "Installing npm dependencies"
  ( cd "${prefix}" && MEMOS_SKIP_SETUP=1 npm install --omit=dev --no-fund --no-audit --loglevel=error >/dev/null 2>&1 )
  [[ -d "${prefix}/node_modules" ]] || die "npm install failed in ${prefix}"

  if [[ -d "${prefix}/node_modules/better-sqlite3" ]]; then
    step "Rebuilding better-sqlite3 for Node $(node -v)"
    ( cd "${prefix}" && npm rebuild better-sqlite3 --loglevel=error >/dev/null 2>&1 ) \
      || ( cd "${prefix}" && npm rebuild better-sqlite3 --build-from-source --loglevel=error >/dev/null 2>&1 ) \
      || warn "better-sqlite3 rebuild did not complete cleanly."
    if ( cd "${prefix}" && node -e "require('better-sqlite3')" >/dev/null 2>&1 ); then
      success "better-sqlite3 native module OK"
    else
      warn "better-sqlite3 not loadable — plugin will fail at startup."
      printf "       ${DIM}Fix: cd ${prefix} && npm rebuild better-sqlite3${NC}\n" >&2
    fi
  fi
  success "Dependencies ready"
}

# ─── Generate runtime config.yaml ─────────────────────────────────────────
# The template ships with the right per-agent port baked in
# (`templates/config.openclaw.yaml` → 18799,
#  `templates/config.hermes.yaml` → 18800), so we don't have to
# rewrite `port:` here. Existing files are left untouched.
ensure_runtime_home() {
  local agent="$1" home_dir="$2" prefix="$3"
  mkdir -p "${home_dir}/data" "${home_dir}/skills" "${home_dir}/logs" "${home_dir}/daemon"
  chmod 700 "${home_dir}"

  local template="${prefix}/templates/config.${agent}.yaml"
  [[ ! -f "${template}" ]] && template="${SCRIPT_DIR}/templates/config.${agent}.yaml"
  if [[ ! -f "${template}" ]]; then
    warn "Template missing: config.${agent}.yaml"
    return 0
  fi

  local target="${home_dir}/config.yaml"
  if [[ -f "${target}" ]]; then
    success "config.yaml exists — kept as-is"
  else
    cp "${template}" "${target}"
    chmod 600 "${target}"
    success "Wrote ${target} from template"
  fi
}

# ─── Wait for viewer — spin until HTTP endpoint actually responds ─────────
wait_for_viewer() {
  local port="$1"
  local url="http://127.0.0.1:${port}"
  local timeout="${2:-30}"
  local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  local idx=0
  local elapsed=0
  local spin_tick=0

  while (( elapsed < timeout )); do
    if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 "${url}/" >/dev/null 2>&1; then
      printf "\r\033[K"
      success "Memory Viewer is ready: ${CYAN}${url}${NC}"
      return 0
    fi
    printf "\r  ${BLUE}%s${NC}  Starting Memory Viewer ${DIM}(%ds)${NC} …" "${frames[idx]}" "${elapsed}"
    idx=$(((idx + 1) % ${#frames[@]}))
    sleep 0.12
    spin_tick=$((spin_tick + 1))
    if (( spin_tick % 8 == 0 )); then
      elapsed=$((elapsed + 1))
    fi
  done
  printf "\r\033[K"
  warn "Memory Viewer not ready after ${timeout}s"
  warn "Check: ${CYAN}${url}${NC}  Logs: ~/.openclaw/logs/ or ~/.hermes/memos-plugin/logs/"
  return 1
}

# ─── OpenClaw install ─────────────────────────────────────────────────────
install_openclaw() {
  STEP_CURRENT=0
  header "OpenClaw Install"
  local prefix="${HOME}/.openclaw/extensions/${PLUGIN_ID}"
  local home="${HOME}/.openclaw/memos-plugin"
  local config_path="${HOME}/.openclaw/openclaw.json"
  mkdir -p "${HOME}/.openclaw"

  local oc_bin=""
  if oc_bin="$(find_openclaw_cli)"; then
    step "Stopping OpenClaw gateway"
    "${oc_bin}" gateway stop >/dev/null 2>&1 || true
    sleep 1
    success "Gateway stopped"
  fi

  deploy_tarball_to_prefix "${prefix}"

  step "Configuring runtime environment"
  ensure_runtime_home "openclaw" "${home}" "${prefix}"

  # 4. OpenClaw loads plugins via two artefacts:
  #      (a) package.json::openclaw — cheap metadata (we ship it in tgz)
  #      (b) openclaw.plugin.json   — full manifest (id, kind, configSchema,
  #          extensions)
  #    (b) is generated here so the user never edits it by hand.
  local plugin_version
  plugin_version="$(node -p "require('${prefix}/package.json').version" 2>/dev/null || echo 'unknown')"
  cat > "${prefix}/openclaw.plugin.json" <<EOF
{
  "id": "${PLUGIN_ID}",
  "name": "MemOS Local Memory (V7)",
  "description": "Reflect2Evolve V7 memory — L1/L2/L3 + skill crystallization + tier 1/2/3 retrieval + decision repair.",
  "kind": "memory",
  "version": "${plugin_version}",
  "homepage": "https://github.com/MemTensor/MemOS",
  "requirements": { "node": ">=${REQUIRED_NODE_MAJOR}.0.0" },
  "extensions": ["./adapters/openclaw/index.ts"],
  "configSchema": {
    "type": "object",
    "additionalProperties": true,
    "description": "Edit ${home}/config.yaml to tune LLM / embedding / viewer.",
    "properties": {
      "viewerPort": { "type": "number", "description": "Memory Viewer HTTP port (default ${OPENCLAW_PORT})" }
    }
  }
}
EOF

  step "Patching ${config_path}"
  PLUGIN_ID="${PLUGIN_ID}" \
  INSTALL_PATH="${prefix}" \
  SOURCE_KIND="${SOURCE_KIND}" \
  SOURCE_SPEC="${SOURCE_SPEC}" \
  PLUGIN_VERSION="${plugin_version}" \
  LEGACY_JSON="$(printf '%s,' "${LEGACY_PLUGIN_IDS[@]}")" \
  CONFIG_PATH="${config_path}" \
  node - <<'NODE'
const fs = require('fs');
const {
  CONFIG_PATH: configPath, PLUGIN_ID: pluginId, INSTALL_PATH: installPath,
  SOURCE_KIND: sourceKind, SOURCE_SPEC: sourceSpec,
  PLUGIN_VERSION: pluginVersion, LEGACY_JSON: legacyCsv,
} = process.env;
const legacyIds = (legacyCsv || '').split(',').filter(Boolean);

let config = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, 'utf8').trim();
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
  }
}

if (!config.plugins || typeof config.plugins !== 'object' || Array.isArray(config.plugins)) {
  config.plugins = {};
}
config.plugins.enabled = true;

if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
if (!config.plugins.allow.includes(pluginId)) config.plugins.allow.push(pluginId);

// Remove legacy plugins cleanly (OpenClaw schema rejects unknown keys,
// so we can't just tag them as disabled). The plugin directory on disk
// at ~/.openclaw/extensions/<legacy-id>/ is left untouched; the user
// can delete it themselves if desired.
for (const legacyId of legacyIds) {
  if (config.plugins.entries?.[legacyId]) delete config.plugins.entries[legacyId];
  if (config.plugins.installs?.[legacyId]) delete config.plugins.installs[legacyId];
  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = config.plugins.allow.filter((x) => x !== legacyId);
  }
  if (config.plugins.slots && typeof config.plugins.slots === 'object') {
    for (const [slot, v] of Object.entries(config.plugins.slots)) {
      if (v === legacyId) delete config.plugins.slots[slot];
    }
  }
}

if (!config.plugins.slots || typeof config.plugins.slots !== 'object') config.plugins.slots = {};
config.plugins.slots.memory = pluginId;

if (!config.plugins.entries || typeof config.plugins.entries !== 'object') config.plugins.entries = {};
if (!config.plugins.entries[pluginId] || typeof config.plugins.entries[pluginId] !== 'object') {
  config.plugins.entries[pluginId] = {};
}
config.plugins.entries[pluginId].enabled = true;

if (!config.plugins.installs || typeof config.plugins.installs !== 'object') config.plugins.installs = {};
const installsEntry = {
  source: sourceKind === 'path' ? 'path' : 'npm',
  installPath,
  version: pluginVersion,
  resolvedVersion: pluginVersion,
  installedAt: new Date().toISOString(),
};
if (sourceKind !== 'path') {
  installsEntry.spec = sourceSpec;
  installsEntry.resolvedName = '@memtensor/memos-local-plugin';
  installsEntry.resolvedSpec = sourceSpec;
}
config.plugins.installs[pluginId] = installsEntry;

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
NODE
  success "openclaw.json patched"

  if [[ -z "${oc_bin}" ]]; then
    warn "openclaw CLI not on PATH — restart manually: openclaw gateway start"
    return 1
  fi
  step "Starting OpenClaw gateway"
  local start_out
  if ! start_out="$("${oc_bin}" gateway start 2>&1)"; then
    # launchd KeepAlive may have already restarted the service after
    # the stop above, making "gateway start" fail with a kickstart
    # conflict. Check if the gateway is actually running before
    # treating this as a real error.
    if curl -fsS --max-time 2 "http://127.0.0.1:18789" >/dev/null 2>&1 \
       || (command -v lsof >/dev/null 2>&1 && lsof -i ":18789" -t >/dev/null 2>&1); then
      success "OpenClaw gateway already running"
    else
      error "openclaw gateway start failed:"
      echo "${start_out}" | sed 's/^/       /' >&2
      warn "Inspect ~/.openclaw/logs/gateway.err.log for the full reason."
      return 1
    fi
  else
    success "OpenClaw gateway started"
  fi

  step "Waiting for Memory Viewer"
  if wait_for_viewer "${OPENCLAW_PORT}"; then
    echo
    success "OpenClaw install complete"
    printf "       ${DIM}Plugin:${NC}    %s\n" "${HOME}/.openclaw/extensions/${PLUGIN_ID}"
    printf "       ${DIM}Viewer:${NC}    ${CYAN}http://127.0.0.1:${OPENCLAW_PORT}/${NC}\n"
    return 0
  fi
  warn "Memory Viewer did not respond within 30s."
  printf "       ${DIM}Check: ~/.openclaw/logs/gateway.err.log${NC}\n" >&2
  return 1
}

# ─── Hermes install ───────────────────────────────────────────────────────
install_hermes() {
  STEP_CURRENT=0
  header "Hermes Install"
  local prefix="${HOME}/.hermes/memos-plugin"
  local home="${prefix}"
  local config_file="${HOME}/.hermes/config.yaml"
  local adapter_dir="${prefix}/adapters/hermes"
  mkdir -p "${HOME}/.hermes"

  pkill -f "bridge.cts" >/dev/null 2>&1 || true
  local was_running="false"
  if pgrep -f "/bin/hermes" >/dev/null 2>&1; then
    step "Stopping running Hermes process"
    pkill -f "/bin/hermes" >/dev/null 2>&1 || true
    sleep 2
    pgrep -f "/bin/hermes" >/dev/null 2>&1 && pkill -9 -f "/bin/hermes" >/dev/null 2>&1 || true
    was_running="true"
    success "Hermes stopped"
  fi

  # Free Hermes' viewer port if something (e.g. a stale bridge from
  # a prior install, or the OpenClaw gateway reload) left it occupied.
  if command -v lsof >/dev/null 2>&1; then
    local stale_pid
    stale_pid="$(lsof -i ":${HERMES_PORT}" -t 2>/dev/null || true)"
    if [[ -n "${stale_pid}" ]]; then
      kill ${stale_pid} >/dev/null 2>&1 || true
      sleep 1
    fi
  fi

  deploy_tarball_to_prefix "${prefix}"

  step "Configuring runtime environment"
  ensure_runtime_home "hermes" "${home}" "${prefix}"

  echo "${prefix}/bridge.cts" > "${adapter_dir}/bridge_path.txt"
  success "Bridge path recorded"

  step "Locating Hermes Python environment"
  local python_bin=""
  if command -v hermes >/dev/null 2>&1; then
    local shebang; shebang="$(head -1 "$(command -v hermes)" 2>/dev/null || true)"
    [[ "${shebang}" == "#!"*python* ]] && python_bin="$(echo "${shebang}" | sed 's/^#!\s*//')"
  fi
  if [[ -z "${python_bin}" || ! -x "${python_bin}" ]] \
     && [[ -x "${HOME}/.hermes/hermes-agent/venv/bin/python3" ]]; then
    python_bin="${HOME}/.hermes/hermes-agent/venv/bin/python3"
  fi
  [[ -z "${python_bin}" || ! -x "${python_bin}" ]] && python_bin="$(command -v python3 || true)"
  [[ -n "${python_bin}" && -x "${python_bin}" ]] || die "Cannot locate Python for Hermes."
  success "Python: ${python_bin}"

  local plugin_dir=""
  plugin_dir="$("${python_bin}" -c "
from pathlib import Path
try:
    import plugins.memory as pm
    print(Path(pm.__file__).parent)
except Exception:
    pass
" 2>/dev/null || true)"
  if [[ -z "${plugin_dir}" || ! -d "${plugin_dir}" ]]; then
    for d in "${HOME}/.hermes/hermes-agent/plugins/memory"; do
      [[ -d "${d}" && -f "${d}/__init__.py" ]] && { plugin_dir="${d}"; break; }
    done
  fi
  [[ -n "${plugin_dir}" && -d "${plugin_dir}" ]] || die "plugins/memory not found"
  success "plugins/memory: ${plugin_dir}"

  step "Linking memtensor provider"
  local target="${plugin_dir}/memtensor"
  if [[ -L "${target}" ]]; then rm "${target}"
  elif [[ -e "${target}" ]]; then rm -rf "${target}"
  fi
  ln -s "${adapter_dir}/memos_provider" "${target}"
  cp "${adapter_dir}/plugin.yaml" "${adapter_dir}/memos_provider/plugin.yaml" 2>/dev/null || true
  success "Symlinked → ${target}"

  step "Verifying provider & patching config"
  local verify
  verify="$("${python_bin}" -c "
from plugins.memory import load_memory_provider
p = load_memory_provider('memtensor')
print('OK' if p and p.name == 'memtensor' else 'FAIL')
" 2>/dev/null || true)"
  [[ "${verify}" == "OK" ]] && success "Provider verification passed" \
    || warn "Provider verification didn't return OK"

  if [[ -f "${config_file}" ]]; then
    "${python_bin}" - "${config_file}" <<'PYEOF' || warn "config.yaml auto-patch failed"
import sys, yaml
path = sys.argv[1]
with open(path) as f: cfg = yaml.safe_load(f) or {}
mem = cfg.get("memory")
if isinstance(mem, dict):
    mem["provider"] = "memtensor"
    mem.setdefault("memory_enabled", True)
else:
    cfg["memory"] = {"provider": "memtensor", "memory_enabled": True}
with open(path, "w") as f:
    yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
PYEOF
    success "config.yaml: memory.provider = memtensor"
  else
    cat > "${config_file}" <<'CFGEOF'
memory:
  memory_enabled: true
  user_profile_enabled: true
  provider: memtensor
CFGEOF
    success "Created ${config_file}"
  fi

  # Smoke test — boot the bridge briefly and confirm the viewer
  # actually answers on Hermes' fixed port.
  if command -v lsof >/dev/null 2>&1 && lsof -i ":${HERMES_PORT}" -t >/dev/null 2>&1; then
    warn "Port :${HERMES_PORT} already in use — skipping smoke test."
  else
    step "Starting Memory Viewer daemon"
    local tsx_bin="${prefix}/node_modules/.bin/tsx"
    local bridge_cts="${prefix}/bridge.cts"
    if [[ -x "${tsx_bin}" && -f "${bridge_cts}" ]]; then
      local daemon_log="${prefix}/logs/daemon-start.log"
      mkdir -p "${prefix}/logs"
      # Launch bridge in --daemon mode (pure HTTP, no stdio).
      # The process stays alive to serve the Memory Viewer.
      ( cd "${prefix}" && nohup "${tsx_bin}" "${bridge_cts}" --agent=hermes --daemon >"${daemon_log}" 2>&1 ) &
      disown $! 2>/dev/null || true

      if wait_for_viewer "${HERMES_PORT}"; then
        success "Memory Viewer daemon running"
      else
        error "Memory Viewer did not respond within 30s."
        warn "Re-install dependencies and re-run: cd ${prefix} && npm install"
        return 1
      fi
    else
      warn "tsx not found — skipping daemon start."
    fi
  fi

  echo
  success "Hermes install complete"
  printf "       ${DIM}Plugin:${NC}    %s\n" "${prefix}"
  printf "       ${DIM}Viewer:${NC}    ${CYAN}http://127.0.0.1:${HERMES_PORT}/${NC}\n"
  if [[ "${was_running}" == "true" ]]; then
    printf "       ${DIM}Next:${NC}      ${BOLD}hermes chat${NC}  ${DIM}(was stopped — relaunch to apply)${NC}\n"
  else
    printf "       ${DIM}Next:${NC}      ${BOLD}hermes chat${NC}\n"
  fi
  return 0
}

# ─── Main ─────────────────────────────────────────────────────────────────
banner
pick_agents_interactively

if [[ "${AGENT_SELECTION}" == "auto" ]]; then
  if [[ "${HAS_OPENCLAW}" != "true" && "${HAS_HERMES}" != "true" ]]; then
    die "Neither ~/.openclaw nor ~/.hermes exists. Install OpenClaw or Hermes first."
  fi
  if [[ "${HAS_OPENCLAW}" == "true" && "${HAS_HERMES}" == "true" ]]; then
    AGENT_SELECTION="all"
  elif [[ "${HAS_OPENCLAW}" == "true" ]]; then
    AGENT_SELECTION="openclaw"
  else
    AGENT_SELECTION="hermes"
  fi
  success "Auto-detected: ${AGENT_SELECTION}"
fi

case "${AGENT_SELECTION}" in
  openclaw) [[ "${HAS_OPENCLAW}" == "true" ]] || warn "~/.openclaw missing — will create." ;;
  hermes)   [[ "${HAS_HERMES}"   == "true" ]] || die  "~/.hermes missing — install Hermes first." ;;
  all) ;;
  *) die "Invalid selection: ${AGENT_SELECTION}" ;;
esac

ensure_node
resolve_tarball

STATUS=0
case "${AGENT_SELECTION}" in
  openclaw) install_openclaw || STATUS=1 ;;
  hermes)   install_hermes   || STATUS=1 ;;
  all)
    if [[ "${HAS_OPENCLAW}" == "true" ]]; then install_openclaw || STATUS=1; else warn "Skipping OpenClaw (~/.openclaw not found)"; fi
    if [[ "${HAS_HERMES}"   == "true" ]]; then install_hermes   || STATUS=1; else warn "Skipping Hermes (~/.hermes not found)"; fi
    ;;
esac

echo
if (( STATUS == 0 )); then
  echo
  printf "  ${BOLD}${GREEN}┌──────────────────────────────────────────────────┐${NC}\n"
  printf "  ${BOLD}${GREEN}│${NC}                                                  ${BOLD}${GREEN}│${NC}\n"
  printf "  ${BOLD}${GREEN}│${NC}   ✨  ${BOLD}${GREEN}MemOS Local installed successfully${NC}         ${BOLD}${GREEN}│${NC}\n"
  printf "  ${BOLD}${GREEN}│${NC}                                                  ${BOLD}${GREEN}│${NC}\n"
  printf "  ${BOLD}${GREEN}└──────────────────────────────────────────────────┘${NC}\n"
  echo
  case "${AGENT_SELECTION}" in
    openclaw)
      printf "  ${BOLD}Quick links:${NC}\n"
      printf "    ${GREEN}●${NC}  Memory Viewer   ${CYAN}http://127.0.0.1:${OPENCLAW_PORT}${NC}  ${DIM}(openclaw)${NC}\n"
      printf "    ${GREEN}●${NC}  OpenClaw Web UI  ${CYAN}http://localhost:18789${NC}\n"
      ;;
    hermes)
      printf "  ${BOLD}Quick links:${NC}\n"
      printf "    ${GREEN}●${NC}  Memory Viewer   ${CYAN}http://127.0.0.1:${HERMES_PORT}${NC}  ${DIM}(hermes)${NC}\n"
      ;;
    all)
      printf "  ${BOLD}Quick links:${NC}\n"
      printf "    ${GREEN}●${NC}  Memory Viewer   ${CYAN}http://127.0.0.1:${OPENCLAW_PORT}${NC}  ${DIM}(openclaw)${NC}\n"
      printf "    ${GREEN}●${NC}  Memory Viewer   ${CYAN}http://127.0.0.1:${HERMES_PORT}${NC}  ${DIM}(hermes)${NC}\n"
      printf "    ${GREEN}●${NC}  OpenClaw Web UI  ${CYAN}http://localhost:18789${NC}\n"
      ;;
  esac
  echo
  printf "  ${DIM}Docs: https://github.com/MemTensor/MemOS${NC}\n"
  echo
  exit 0
else
  echo
  printf "  ${BOLD}${RED}┌──────────────────────────────────────────────────┐${NC}\n"
  printf "  ${BOLD}${RED}│${NC}                                                  ${BOLD}${RED}│${NC}\n"
  printf "  ${BOLD}${RED}│${NC}   ${RED}Install finished with errors - see above${NC}       ${BOLD}${RED}│${NC}\n"
  printf "  ${BOLD}${RED}│${NC}                                                  ${BOLD}${RED}│${NC}\n"
  printf "  ${BOLD}${RED}└──────────────────────────────────────────────────┘${NC}\n"
  echo
  exit 1
fi
