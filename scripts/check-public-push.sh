#!/usr/bin/env bash
# Pre-push hook: block private files from being pushed to the public repo.
# Private paths are read from .private-paths (one per line, # comments allowed).
# Installed by `make install` into .git/hooks/pre-push.

REMOTE_NAME="$1"
REMOTE_URL="$2"

# Only enforce on the public remote (skip MemOS-Enterprise)
if [[ "${REMOTE_URL}" != *"MemTensor/MemOS.git"* ]] || [[ "${REMOTE_URL}" == *"MemOS-Enterprise"* ]]; then
    exit 0
fi

PRIVATE_PATHS_FILE=".private-paths"
if [ ! -f "${PRIVATE_PATHS_FILE}" ]; then
    echo "⚠️  ${PRIVATE_PATHS_FILE} not found — skipping private-path check."
    exit 0
fi

# Read private paths into regex patterns
PATTERNS=()
while IFS= read -r line; do
    line="$(echo "${line}" | sed 's/#.*//; s/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "${line}" ] && continue
    # Convert path to regex: strip trailing /, add ^ anchor
    pattern="^$(echo "${line}" | sed 's|/$||')"
    PATTERNS+=("${pattern}")
done < "${PRIVATE_PATHS_FILE}"

ERRORS=0

while read local_ref local_sha remote_ref remote_sha; do
    # Skip delete operations
    if [ "${local_sha}" = "0000000000000000000000000000000000000000" ]; then
        continue
    fi

    # For new remote refs, compare against public/main
    if [ "${remote_sha}" = "0000000000000000000000000000000000000000" ]; then
        base=$(git merge-base public/main "${local_sha}" 2>/dev/null || echo "public/main")
        range="${base}..${local_sha}"
    else
        range="${remote_sha}..${local_sha}"
    fi

    files=$(git diff --name-only "${range}" 2>/dev/null || true)
    if [ -z "${files}" ]; then
        continue
    fi

    for pattern in "${PATTERNS[@]}"; do
        matched=$(echo "${files}" | grep -E "${pattern}" || true)
        if [ -n "${matched}" ]; then
            echo "❌ BLOCKED: Private files detected in push to public repo!"
            echo ""
            echo "   Pattern: ${pattern}"
            echo "   Files:"
            echo "${matched}" | sed 's/^/      /'
            echo ""
            ERRORS=1
        fi
    done
done

if [ "${ERRORS}" -ne 0 ]; then
    echo "💡 Use 'git sync-public \"<message>\"' to safely sync CE code."
    exit 1
fi

exit 0
