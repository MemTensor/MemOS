#!/usr/bin/env bash
set -euo pipefail

# Sync CE-only changes from the enterprise repo to the public repo.
# Private paths are read from .private-paths (one per line, # comments allowed).
#
# Usage:
#   git sync-public "<commit message>" [commit-ref]
#   make sync-public msg="<commit message>" [commit=<ref>]

PUBLIC_REMOTE="public"
PRIVATE_PATHS_FILE=".private-paths"

CE_MSG="${1:?Usage: git sync-public \"<commit message>\" [commit-ref]}"
COMMIT="${2:-HEAD}"
EE_BRANCH="$(git branch --show-current)"
PUBLIC_BRANCH="public-$(echo "${EE_BRANCH}" | tr '/' '-')"

# Read private paths from config file
if [ ! -f "${PRIVATE_PATHS_FILE}" ]; then
    echo "❌ ${PRIVATE_PATHS_FILE} not found. Cannot determine private paths."
    exit 1
fi

EXCLUDE_ARGS=""
while IFS= read -r line; do
    line="$(echo "${line}" | sed 's/#.*//; s/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "${line}" ] && continue
    EXCLUDE_ARGS="${EXCLUDE_ARGS} ':!${line}'"
done < "${PRIVATE_PATHS_FILE}"

git fetch "${PUBLIC_REMOTE}" main

# Find CE files changed in the specified commit
CE_FILES=$(eval git diff --name-only "${COMMIT}^..${COMMIT}" -- . ${EXCLUDE_ARGS})

if [ -z "${CE_FILES}" ]; then
    echo "✅ No CE changes in commit $(git rev-parse --short "${COMMIT}"). Done."
    exit 0
fi

echo "▶ CE changes from $(git log -1 --format='%h %s' "${COMMIT}"):"
echo "${CE_FILES}" | sed 's/^/   /'

# Reuse existing public branch or create from public/main
if git show-ref --verify --quiet "refs/heads/${PUBLIC_BRANCH}"; then
    git checkout "${PUBLIC_BRANCH}"
else
    git checkout -B "${PUBLIC_BRANCH}" "${PUBLIC_REMOTE}/main"
fi

# Checkout CE files from the enterprise commit
echo "${CE_FILES}" | xargs git checkout "${COMMIT}" --

git commit --no-verify -m "${CE_MSG}"
echo "▶ Pushing ${PUBLIC_BRANCH} to ${PUBLIC_REMOTE}..."
git push "${PUBLIC_REMOTE}" "${PUBLIC_BRANCH}"
git checkout "${EE_BRANCH}"

echo ""
echo "✅ Done. Create PR:"
echo "   https://github.com/MemTensor/MemOS/pull/new/${PUBLIC_BRANCH}"
