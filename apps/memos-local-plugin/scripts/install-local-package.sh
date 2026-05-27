#!/usr/bin/env bash
# Build a local npm tarball and install the plugin from that tarball.
#
# Usage:
#   bash scripts/install-local-package.sh
#   bash scripts/install-local-package.sh --agent openclaw
#   npm run install:local -- --agent openclaw
#
# The generated tarball is written to ./local-packages/ and then passed to
# install.sh via --version ./local-packages/<package>.tgz. Any arguments passed
# to this script are forwarded to install.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PACKAGE_DIR="${MEMOS_LOCAL_PACKAGE_DIR:-${ROOT_DIR}/local-packages}"
PACKAGE_GLOB="memtensor-memos-local-plugin-*.tgz"

info() {
  printf "  \033[0;34m›\033[0m %s\n" "$*"
}

success() {
  printf "  \033[0;32m✔\033[0m %s\n" "$*"
}

die() {
  printf "  \033[0;31m✘\033[0m %s\n" "$*" >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || die "npm is required but was not found in PATH."

mkdir -p "${PACKAGE_DIR}"

if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
  info "Installing project dependencies"
  (
    cd "${ROOT_DIR}"
    npm ci
  )
fi

info "Cleaning old local packages in ${PACKAGE_DIR}"
rm -f "${PACKAGE_DIR}/${PACKAGE_GLOB}"

info "Packing @memtensor/memos-local-plugin"
(
  cd "${ROOT_DIR}"
  npm pack --pack-destination "${PACKAGE_DIR}"
)

shopt -s nullglob
tarballs=("${PACKAGE_DIR}"/${PACKAGE_GLOB})
shopt -u nullglob

if [[ "${#tarballs[@]}" -ne 1 ]]; then
  die "Expected exactly one local package in ${PACKAGE_DIR}, found ${#tarballs[@]}."
fi

TARBALL="${tarballs[0]}"
success "Local npm package created: ${TARBALL}"

info "Installing plugin from local package"
bash "${ROOT_DIR}/install.sh" --version "${TARBALL}" "$@"

