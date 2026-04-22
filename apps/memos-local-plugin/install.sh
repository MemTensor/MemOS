#!/usr/bin/env bash
# install.sh — one-command installer for @memtensor/memos-local-plugin.
#
# Usage:
#   bash install.sh                        # install latest from npm
#   bash install.sh --version 2.0.0        # install specific npm version
#   bash install.sh --version ./pkg.tgz    # use a local tarball
#   bash install.sh --port 18799           # override viewer port (default 18799)
#
# Interactive: with a TTY we ask where to install (OpenClaw / Hermes /
# both). Press ENTER for auto-detect. Non-TTY falls straight to
# auto-detect. macOS + Linux only.
#
# Design notes:
#   - The viewer port is **shared** between agents. Each agent runs in
#     its own process and only one can own the port at a time, which is
#     the desired behaviour: when OpenClaw is running the viewer shows
#     OpenClaw's memory; stopping OpenClaw and starting Hermes hands the
#     same URL over to Hermes. There's no cross-agent memory in one UI
#     — each agent keeps its own DB under `~/.<agent>/memos-plugin/`.
#   - All install logic is self-contained: Node bootstrap, tarball
#     resolution, better-sqlite3 rebuild, config patching, gateway
#     restart, viewer-readiness wait. No separate sub-scripts.

set -euo pipefail

# ─── Colors ────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()    { printf "${BLUE}%s${NC}\n" "$*"; }
success() { printf "${GREEN}✓ %s${NC}\n" "$*"; }
warn()    { printf "${YELLOW}⚠ %s${NC}\n" "$*" >&2; }
error()   { printf "${RED}✗ %s${NC}\n" "$*" >&2; }
die()     { error "$*"; exit 1; }
header()  { printf "\n${BOLD}${BLUE}── %s ──${NC}\n\n" "$*"; }

banner() {
  printf "\n${BOLD}${BLUE}╔════════════════════════════════════════════════════╗${NC}\n"
  printf "${BOLD}${BLUE}║  🧠  MemOS Local — Reflect2Evolve V7 Installer    ║${NC}\n"
  printf "${BOLD}${BLUE}╚════════════════════════════════════════════════════╝${NC}\n"
  printf "${DIM}Layered L1/L2/L3 memory, skill crystallization, tier 1/2/3 retrieval.${NC}\n\n"
}

# ─── Constants ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
PLUGIN_ID="memos-local-plugin"
NPM_PACKAGE="@memtensor/memos-local-plugin"
DEFAULT_PORT="18799"
REQUIRED_NODE_MAJOR=20
# Older plugin IDs disabled on install so they don't fight for the
# memory slot. We never touch the old plugin's data.
LEGACY_PLUGIN_IDS=("memos-local-openclaw-plugin")

# ─── Args — two flags, period ─────────────────────────────────────────────
VERSION_ARG=""
PORT="${DEFAULT_PORT}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION_ARG="${2:-}"; shift 2 ;;
    --port)    PORT="${2:-}"; shift 2 ;;
    -h|--help)
      cat <<EOF
Usage:
  bash install.sh                     # latest from npm
  bash install.sh --version X.Y.Z     # specific npm version
  bash install.sh --version ./pkg.tgz # local tarball
  bash install.sh --port 18799        # override viewer port (default ${DEFAULT_PORT})
EOF
      exit 0
      ;;
    *) die "Unknown argument: $1 (use --version or --port)" ;;
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
    warn "Node $(node -v) has no better-sqlite3 prebuild — will compile from source."
    warn "Ensure C++ build tools are available:"
    warn "  macOS:  xcode-select --install"
    warn "  Linux:  sudo apt install build-essential python3"
    warn "Or switch to Node LTS (22/24) for prebuilt binaries: nvm install 22"
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
  printf "${BOLD}Detected agents:${NC}\n"
  [[ "${HAS_OPENCLAW}" == "true" ]] && success "  OpenClaw   (${HOME}/.openclaw)" || printf "${DIM}  OpenClaw   (not installed)${NC}\n"
  [[ "${HAS_HERMES}"   == "true" ]] && success "  Hermes     (${HOME}/.hermes)"   || printf "${DIM}  Hermes     (not installed)${NC}\n"
  echo
  printf "${BOLD}Install into which agent?${NC}\n"
  printf "  [Enter]  auto-detect\n"
  printf "  1        OpenClaw only\n"
  printf "  2        Hermes only\n"
  printf "  3        Both\n"
  printf "  q        Quit\n"
  printf "Choice: "
  local choice
  if [[ ! -t 0 ]]; then
    echo "(non-interactive — auto-detect)"; choice=""
  else
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
    info "Using local tarball: ${BUILT_TARBALL}"
    return 0
  fi

  local spec
  if [[ -z "${VERSION_ARG}" ]]; then
    spec="${NPM_PACKAGE}"
    info "Fetching latest ${NPM_PACKAGE} from npm..."
  else
    spec="${NPM_PACKAGE}@${VERSION_ARG}"
    info "Fetching ${spec} from npm..."
  fi
  SOURCE_KIND="npm"
  SOURCE_SPEC="${spec}"

  (cd "${STAGE_DIR}" && npm pack "${spec}" --loglevel=error >/dev/null)
  BUILT_TARBALL="$(ls "${STAGE_DIR}"/*.tgz 2>/dev/null | head -1)"
  [[ -n "${BUILT_TARBALL}" && -f "${BUILT_TARBALL}" ]] \
    || die "npm pack failed for ${spec}. Check the npm registry or pass a local path via --version ./pkg.tgz"
  success "Package downloaded: $(basename "${BUILT_TARBALL}")"
}

# ─── Deploy tarball into a prefix + rebuild native deps ───────────────────
deploy_tarball_to_prefix() {
  local prefix="$1"
  info "Deploying to ${prefix}..."
  if [[ -d "${prefix}" ]]; then
    local saved=""
    if [[ -d "${prefix}/node_modules" ]]; then
      saved="$(mktemp -d)"
      mv "${prefix}/node_modules" "${saved}/node_modules"
    fi
    rm -rf "${prefix}"
    mkdir -p "${prefix}"
    tar xzf "${BUILT_TARBALL}" -C "${prefix}" --strip-components=1
    if [[ -n "${saved}" ]]; then mv "${saved}/node_modules" "${prefix}/node_modules"; rm -rf "${saved}"; fi
  else
    mkdir -p "${prefix}"
    tar xzf "${BUILT_TARBALL}" -C "${prefix}" --strip-components=1
  fi
  [[ -f "${prefix}/package.json" ]] || die "Extraction failed: ${prefix}/package.json missing"

  info "Installing npm dependencies..."
  ( cd "${prefix}" && MEMOS_SKIP_SETUP=1 npm install --omit=dev --no-fund --no-audit --loglevel=error )
  [[ -d "${prefix}/node_modules" ]] || die "npm install failed in ${prefix}"

  # Rebuild better-sqlite3 against the active Node ABI. Required on
  # Node ≥ 25 (no prebuilds) and safe on Node 22/24 too.
  if [[ -d "${prefix}/node_modules/better-sqlite3" ]]; then
    info "Rebuilding better-sqlite3 for Node $(node -v)..."
    ( cd "${prefix}" && npm rebuild better-sqlite3 --loglevel=error >/dev/null 2>&1 ) \
      || ( cd "${prefix}" && npm rebuild better-sqlite3 --build-from-source --loglevel=error >/dev/null 2>&1 ) \
      || warn "better-sqlite3 rebuild did not complete cleanly — see output above."
    if ( cd "${prefix}" && node -e "require('better-sqlite3')" >/dev/null 2>&1 ); then
      success "better-sqlite3 loads"
    else
      warn "better-sqlite3 native module not loadable — plugin will fail at startup."
      warn "Fix: install build tools, then run: cd ${prefix} && npm rebuild better-sqlite3"
    fi
  fi
  success "Dependencies installed"
}

# ─── Generate runtime config.yaml ─────────────────────────────────────────
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
    # Align viewer port with --port but keep the rest of the user's
    # existing config.
    sed -i.bak "s/^\( *port: *\).*/\1${PORT}/" "${target}" && rm -f "${target}.bak"
    info "config.yaml at ${target} — viewer port set to ${PORT}"
  else
    cp "${template}" "${target}"
    sed -i.bak "s/^\( *port: *\).*/\1${PORT}/" "${target}" && rm -f "${target}.bak"
    chmod 600 "${target}"
    success "Wrote ${target} (viewer port ${PORT})"
  fi
}

# ─── Wait for viewer (adapted from legacy install.sh's spinner) ──────────
wait_for_viewer() {
  local url="http://127.0.0.1:${PORT}"
  local deadline=$((SECONDS + 30))
  local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  local idx=0
  while (( SECONDS < deadline )); do
    if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 0.3 "${url}/" >/dev/null 2>&1; then
      printf "\r\033[K"
      success "Memory Viewer ready: ${url}"
      return 0
    fi
    if command -v lsof >/dev/null 2>&1 && lsof -i ":${PORT}" -t >/dev/null 2>&1; then
      printf "\r\033[K"
      success "Memory Viewer listening on :${PORT} (may still be initialising)"
      return 0
    fi
    printf "\r${BLUE}%s${NC} Waiting for Memory Viewer on :${PORT}... " "${frames[idx]}"
    idx=$(((idx + 1) % ${#frames[@]}))
    sleep 0.2
  done
  printf "\r\033[K"
  return 1
}

# ─── OpenClaw install ─────────────────────────────────────────────────────
install_openclaw() {
  header "OpenClaw install"
  local prefix="${HOME}/.openclaw/extensions/${PLUGIN_ID}"
  local home="${HOME}/.openclaw/memos-plugin"
  local config_path="${HOME}/.openclaw/openclaw.json"
  mkdir -p "${HOME}/.openclaw"

  # 1. Stop gateway first — avoids SQLite + better-sqlite3 file locks.
  local oc_bin=""
  if oc_bin="$(find_openclaw_cli)"; then
    info "Stopping OpenClaw gateway..."
    "${oc_bin}" gateway stop >/dev/null 2>&1 || true
    sleep 1
  fi

  # 2. Deploy + rebuild native deps.
  deploy_tarball_to_prefix "${prefix}"

  # 3. Runtime home + config.yaml.
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
      "viewerPort": { "type": "number", "description": "Memory Viewer HTTP port (default ${DEFAULT_PORT})" }
    }
  }
}
EOF

  # 5. Patch ~/.openclaw/openclaw.json.
  info "Patching ${config_path}..."
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
  success "openclaw.json patched (source: ${SOURCE_KIND}, slot: memory)"

  # 6. Start gateway — surface failures instead of swallowing them.
  if [[ -z "${oc_bin}" ]]; then
    warn "openclaw CLI not on PATH — restart manually: openclaw gateway start"
    return 1
  fi
  info "Starting OpenClaw gateway..."
  local start_out
  if ! start_out="$("${oc_bin}" gateway start 2>&1)"; then
    error "openclaw gateway start failed:"
    echo "${start_out}" | sed 's/^/  /' >&2
    warn "Inspect ~/.openclaw/logs/gateway.err.log for the full reason."
    return 1
  fi
  success "OpenClaw gateway started"

  # 7. Wait for our viewer to answer.
  if wait_for_viewer; then
    return 0
  fi
  warn "Memory Viewer did not respond within 30s."
  warn "Inspect ~/.openclaw/logs/gateway.err.log for plugin init errors."
  return 1
}

# ─── Hermes install ───────────────────────────────────────────────────────
install_hermes() {
  header "Hermes install"
  local prefix="${HOME}/.hermes/memos-plugin"
  local home="${prefix}"
  local config_file="${HOME}/.hermes/config.yaml"
  local adapter_dir="${prefix}/adapters/hermes"
  mkdir -p "${HOME}/.hermes"

  # Stop old bridge + hermes so new config applies.
  pkill -f "bridge.cts" >/dev/null 2>&1 || true
  local was_running="false"
  if pgrep -f "/bin/hermes" >/dev/null 2>&1; then
    info "Stopping running hermes process..."
    pkill -f "/bin/hermes" >/dev/null 2>&1 || true
    sleep 2
    pgrep -f "/bin/hermes" >/dev/null 2>&1 && pkill -9 -f "/bin/hermes" >/dev/null 2>&1 || true
    was_running="true"
  fi

  deploy_tarball_to_prefix "${prefix}"
  ensure_runtime_home "hermes" "${home}" "${prefix}"

  echo "${prefix}/bridge.cts" > "${adapter_dir}/bridge_path.txt"
  success "Recorded bridge path"

  # Locate Hermes Python venv.
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
  success "Hermes Python: ${python_bin}"

  # plugins/memory discovery.
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
  success "Hermes plugins/memory: ${plugin_dir}"

  # Symlink memtensor provider.
  local target="${plugin_dir}/memtensor"
  if [[ -L "${target}" ]]; then rm "${target}"
  elif [[ -e "${target}" ]]; then rm -rf "${target}"
  fi
  ln -s "${adapter_dir}/memos_provider" "${target}"
  cp "${adapter_dir}/plugin.yaml" "${adapter_dir}/memos_provider/plugin.yaml" 2>/dev/null || true
  success "Symlinked memtensor provider → ${target}"

  # Verify + patch config.yaml.
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

  echo
  success "Hermes install complete"
  info "  Plugin:    ${prefix}"
  info "  Viewer:    http://127.0.0.1:${PORT}/ (opens with first turn)"
  if [[ "${was_running}" == "true" ]]; then
    info "  Next step: ${BOLD}hermes chat${NC} ${DIM}(hermes was stopped — relaunch to apply)${NC}"
  else
    info "  Next step: ${BOLD}hermes chat${NC}"
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
  info "Auto-detected: ${AGENT_SELECTION}"
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
  printf "${BOLD}${GREEN}══════════════════════════════════════════════════${NC}\n"
  printf "${BOLD}${GREEN}  ✨ MemOS Local installed successfully${NC}\n"
  printf "${BOLD}${GREEN}══════════════════════════════════════════════════${NC}\n"
  echo
  info "  Memory Viewer: http://127.0.0.1:${PORT}"
  [[ "${AGENT_SELECTION}" != "hermes" ]] && info "  OpenClaw Web UI: http://localhost:18789"
  exit 0
else
  printf "${BOLD}${RED}══════════════════════════════════════════════════${NC}\n"
  printf "${BOLD}${RED}  Install finished with errors — see ✗ lines above${NC}\n"
  printf "${BOLD}${RED}══════════════════════════════════════════════════${NC}\n"
  exit 1
fi
