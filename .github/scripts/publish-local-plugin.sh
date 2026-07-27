#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required.}"
: "${PACKAGE_NAME:?PACKAGE_NAME is required.}"
: "${RELEASE_VERSION:?RELEASE_VERSION is required.}"
: "${RELEASE_TAG:?RELEASE_TAG is required.}"
: "${NPM_DIST_TAG:?NPM_DIST_TAG is required.}"

npm_visibility_attempts="${NPM_VISIBILITY_ATTEMPTS:-10}"
npm_ambiguous_visibility_attempts="${NPM_AMBIGUOUS_VISIBILITY_ATTEMPTS:-3}"
npm_visibility_delay_seconds="${NPM_VISIBILITY_DELAY_SECONDS:-5}"

validate_positive_integer() {
  local name="$1"
  local value="$2"
  if ! [[ "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::${name} must be a positive integer; received ${value}."
    exit 2
  fi
}

validate_non_negative_integer() {
  local name="$1"
  local value="$2"
  if ! [[ "${value}" =~ ^[0-9]+$ ]]; then
    echo "::error::${name} must be a non-negative integer; received ${value}."
    exit 2
  fi
}

validate_positive_integer "NPM_VISIBILITY_ATTEMPTS" "${npm_visibility_attempts}"
validate_positive_integer "NPM_AMBIGUOUS_VISIBILITY_ATTEMPTS" "${npm_ambiguous_visibility_attempts}"
validate_non_negative_integer "NPM_VISIBILITY_DELAY_SECONDS" "${npm_visibility_delay_seconds}"

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
npm_view_log="${RUNNER_TEMP}/memos-local-plugin-npm-view.log"

npm_version_exists() {
  local attempt
  local status

  for attempt in 1 2 3; do
    set +e
    npm view "${PACKAGE_NAME}@${RELEASE_VERSION}" version --prefer-online >"${npm_view_log}" 2>&1
    status=$?
    set -e
    if [ "${status}" = 0 ]; then
      sed -n '1,40p' "${npm_view_log}"
      return 0
    fi
    if grep -Eiq "E404|404 Not Found|No match found|is not in this registry" "${npm_view_log}"; then
      return 1
    fi
    sed -n '1,120p' "${npm_view_log}"
    if [ "${attempt}" = 3 ]; then
      echo "::error::npm view failed after three attempts; refusing to guess whether ${PACKAGE_NAME}@${RELEASE_VERSION} exists."
      exit "${status}"
    fi
    sleep "$((attempt * 5))"
  done
}

wait_for_npm_version() {
  local attempts="$1"
  local attempt
  local delay

  for attempt in $(seq 1 "${attempts}"); do
    if npm_version_exists; then
      echo "${PACKAGE_NAME}@${RELEASE_VERSION} became visible on attempt ${attempt}/${attempts}."
      return 0
    fi
    if [ "${attempt}" = "${attempts}" ]; then
      return 1
    fi

    delay=$((npm_visibility_delay_seconds * attempt))
    if [ "${delay}" -gt 30 ]; then
      delay=30
    fi
    echo "::notice::${PACKAGE_NAME}@${RELEASE_VERSION} is not visible yet; retrying in ${delay}s."
    if [ "${delay}" -gt 0 ]; then
      sleep "${delay}"
    fi
  done

  return 1
}

remote_tag_exists() {
  local release_tag="$1"
  local attempt
  local status

  for attempt in 1 2 3; do
    set +e
    git ls-remote --exit-code --tags origin "refs/tags/${release_tag}" >/dev/null 2>&1
    status=$?
    set -e
    if [ "${status}" = 0 ]; then
      return 0
    fi
    if [ "${status}" = 2 ]; then
      return 1
    fi
    if [ "${attempt}" = 3 ]; then
      echo "::error::Failed to check remote tag ${release_tag} after three attempts."
      exit "${status}"
    fi
    sleep "$((attempt * 5))"
  done
}

if npm_version_exists; then
  if remote_tag_exists "${RELEASE_TAG}"; then
    echo "${PACKAGE_NAME}@${RELEASE_VERSION} and ${RELEASE_TAG} already exist; treating this as an idempotent rerun."
  elif [ "${RECOVER_EXISTING_NPM_RELEASE:-false}" = "true" ]; then
    echo "Recovery mode enabled; npm version exists, so publish is skipped."
  else
    echo "::error::npm version exists but ${RELEASE_TAG} does not. Refusing to invent release metadata without explicit recovery mode."
    exit 1
  fi
else
  attempt_directory="${RUNNER_TEMP}/memos-local-plugin-npm-publish-attempts"
  mkdir -p "${attempt_directory}"
  publish_accepted=false

  for attempt in 1 2 3; do
    set +e
    npm publish --access public --tag "${NPM_DIST_TAG}" >"${attempt_directory}/${attempt}.log" 2>&1
    publish_status=$?
    set -e
    sed -n '1,160p' "${attempt_directory}/${attempt}.log"

    if [ "${publish_status}" = 0 ]; then
      publish_accepted=true
      break
    fi

    if wait_for_npm_version "${npm_ambiguous_visibility_attempts}"; then
      echo "Publish returned an error, but npm now contains the requested version."
      publish_accepted=true
      break
    fi

    if [ "${attempt}" = 3 ]; then
      RELEASE_FAILURE_PHASE=npm-publish \
        RELEASE_FAILURE_ATTEMPT_DIR="${attempt_directory}" \
        node "${script_directory}/draft-local-plugin-release-notes.mjs" \
        || echo "::warning::Failed to send the exhausted-retry notification."
      echo "::error::npm publish failed after three attempts."
      exit 1
    fi

    delay=$((npm_visibility_delay_seconds * attempt))
    if [ "${delay}" -gt 0 ]; then
      sleep "${delay}"
    fi
  done

  if ! wait_for_npm_version "${npm_visibility_attempts}"; then
    if [ "${publish_accepted}" = "true" ]; then
      echo "::warning::npm publish succeeded, but ${PACKAGE_NAME}@${RELEASE_VERSION} is not visible after propagation retries; continuing with tag, Release, and PR creation."
    else
      echo "::error::npm publish did not succeed and ${PACKAGE_NAME}@${RELEASE_VERSION} is still absent."
      exit 1
    fi
  fi
fi
