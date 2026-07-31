#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required.}"
: "${PACKAGE_NAME:?PACKAGE_NAME is required.}"
: "${RELEASE_VERSION:?RELEASE_VERSION is required.}"
: "${RELEASE_TAG:?RELEASE_TAG is required.}"
: "${NPM_DIST_TAG:?NPM_DIST_TAG is required.}"
: "${RELEASE_TARBALL:?RELEASE_TARBALL is required.}"

if [ ! -s "${RELEASE_TARBALL}" ]; then
  echo "::error::RELEASE_TARBALL does not exist or is empty: ${RELEASE_TARBALL}"
  exit 2
fi

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

verify_published_package() {
  local verify_directory="${RUNNER_TEMP}/memos-local-plugin-registry-verification"
  local verify_json="${verify_directory}/npm-pack.json"
  local verify_filename
  local verify_tarball
  local package_version
  local manifest_version

  mkdir -p "${verify_directory}"
  bash "${script_directory}/retry.sh" --label "download published npm package" -- \
    bash -euo pipefail -c 'npm pack "$1" --json --silent --pack-destination "$2" > "$3"' \
    _ "${PACKAGE_NAME}@${RELEASE_VERSION}" "${verify_directory}" "${verify_json}"
  verify_filename="$(
    node -e '
      const fs = require("node:fs");
      const raw = fs.readFileSync(process.argv[1], "utf8");
      const jsonStart = raw.match(/^\[/m);
      if (!jsonStart || jsonStart.index === undefined) {
        throw new Error("npm pack output did not contain a JSON report");
      }
      const report = JSON.parse(raw.slice(jsonStart.index));
      if (!Array.isArray(report) || report.length !== 1 || !report[0].filename) {
        throw new Error("npm pack did not report exactly one registry tarball");
      }
      fs.writeFileSync(process.argv[1], `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(report[0].filename);
    ' "${verify_json}"
  )"
  verify_tarball="${verify_directory}/${verify_filename}"
  package_version="$(
    tar -xOf "${verify_tarball}" package/package.json \
      | node -e '
          const fs = require("node:fs");
          process.stdout.write(JSON.parse(fs.readFileSync(0, "utf8")).version);
        '
  )"
  manifest_version="$(
    tar -xOf "${verify_tarball}" package/adapters/hermes/plugin.yaml \
      | awk '$1 == "version:" { print $2; exit }'
  )"
  if [ "${package_version}" != "${RELEASE_VERSION}" ]; then
    echo "::error::Published package.json version ${package_version} does not match ${RELEASE_VERSION}."
    exit 1
  fi
  if [ "${manifest_version}" != "${RELEASE_VERSION}" ]; then
    echo "::error::Published Hermes manifest version ${manifest_version} does not match ${RELEASE_VERSION}."
    exit 1
  fi
}

published_version_visible=false
if npm_version_exists; then
  published_version_visible=true
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
    npm publish "${RELEASE_TARBALL}" --access public --tag "${NPM_DIST_TAG}" >"${attempt_directory}/${attempt}.log" 2>&1
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

  if wait_for_npm_version "${npm_visibility_attempts}"; then
    published_version_visible=true
  else
    if [ "${publish_accepted}" = "true" ]; then
      echo "::warning::npm publish succeeded, but ${PACKAGE_NAME}@${RELEASE_VERSION} is not visible after propagation retries; continuing with tag, Release, and PR creation."
    else
      echo "::error::npm publish did not succeed and ${PACKAGE_NAME}@${RELEASE_VERSION} is still absent."
      exit 1
    fi
  fi
fi

if [ "${published_version_visible}" = "true" ]; then
  verify_published_package
else
  echo "::warning::Skipping registry tarball verification until ${PACKAGE_NAME}@${RELEASE_VERSION} becomes visible."
fi
