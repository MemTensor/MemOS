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

npm_visibility_timeout_seconds="${NPM_VISIBILITY_TIMEOUT_SECONDS:-150}"
npm_visibility_interval_seconds="${NPM_VISIBILITY_INTERVAL_SECONDS:-10}"
npm_visibility_request_timeout_seconds="${NPM_VISIBILITY_REQUEST_TIMEOUT_SECONDS:-8}"
npm_registry_url="https://registry.npmjs.org"
release_metadata_state="${RELEASE_METADATA_STATE:-fresh}"
allow_staged_tag_before_npm="${ALLOW_STAGED_TAG_BEFORE_NPM:-false}"

validate_positive_integer() {
  local name="$1"
  local value="$2"
  if ! [[ "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::${name} must be a positive integer; received ${value}."
    exit 2
  fi
}

validate_positive_integer "NPM_VISIBILITY_TIMEOUT_SECONDS" "${npm_visibility_timeout_seconds}"
validate_positive_integer "NPM_VISIBILITY_INTERVAL_SECONDS" "${npm_visibility_interval_seconds}"
validate_positive_integer "NPM_VISIBILITY_REQUEST_TIMEOUT_SECONDS" "${npm_visibility_request_timeout_seconds}"

case "${release_metadata_state}" in
  fresh|complete) ;;
  *)
    echo "::error::RELEASE_METADATA_STATE must be fresh or complete; received ${release_metadata_state}."
    exit 2
    ;;
esac

case "${allow_staged_tag_before_npm}" in
  true|false) ;;
  *)
    echo "::error::ALLOW_STAGED_TAG_BEFORE_NPM must be true or false; received ${allow_staged_tag_before_npm}."
    exit 2
    ;;
esac

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
npm_view_log="${RUNNER_TEMP}/memos-local-plugin-npm-view.log"

npm_version_exists() {
  local attempt
  local status

  for attempt in 1 2 3; do
    set +e
    npm view "${PACKAGE_NAME}@${RELEASE_VERSION}" version \
      --prefer-online \
      --fetch-retries=0 \
      --fetch-timeout=8000 \
      --registry="${npm_registry_url}" \
      >"${npm_view_log}" 2>&1
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

wait_for_fresh_npm_release_metadata() {
  NPM_PACKAGE_NAME="${PACKAGE_NAME}" \
    NPM_RELEASE_VERSION="${RELEASE_VERSION}" \
    NPM_DIST_TAG="${NPM_DIST_TAG}" \
    NPM_RELEASE_TARBALL="${RELEASE_TARBALL}" \
    NPM_VISIBILITY_TIMEOUT_SECONDS="${npm_visibility_timeout_seconds}" \
    NPM_VISIBILITY_INTERVAL_SECONDS="${npm_visibility_interval_seconds}" \
    NPM_VISIBILITY_REQUEST_TIMEOUT_SECONDS="${npm_visibility_request_timeout_seconds}" \
    NPM_CONFIG_REGISTRY="${npm_registry_url}" \
    node "${script_directory}/wait-for-local-plugin-npm-release.mjs"
}

npm_dist_tag_matches() {
  local output_file="${RUNNER_TEMP}/memos-local-plugin-npm-dist-tags.json"
  local status
  set +e
  npm view "${PACKAGE_NAME}" dist-tags \
    --json \
    --prefer-online \
    --fetch-retries=0 \
    --fetch-timeout=8000 \
    --registry="${npm_registry_url}" \
    >"${output_file}" 2>&1
  status=$?
  set -e
  if [ "${status}" != 0 ]; then
    sed -n '1,120p' "${output_file}"
    return 1
  fi
  node -e '
    const fs = require("node:fs");
    const tags = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (tags[process.argv[2]] !== process.argv[3]) process.exit(1);
  ' "${output_file}" "${NPM_DIST_TAG}" "${RELEASE_VERSION}"
}

read_current_npm_dist_tag() {
  local output_file="${RUNNER_TEMP}/memos-local-plugin-npm-dist-tags-preflight.json"
  local attempt
  local status

  for attempt in 1 2 3; do
    set +e
    npm view "${PACKAGE_NAME}" dist-tags \
      --json \
      --prefer-online \
      --fetch-retries=0 \
      --fetch-timeout=8000 \
      --registry="${npm_registry_url}" \
      >"${output_file}" 2>&1
    status=$?
    set -e
    if [ "${status}" = 0 ]; then
      node -e '
        const fs = require("node:fs");
        const tags = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const value = tags[process.argv[2]];
        if (value !== undefined && typeof value !== "string") {
          throw new Error(`npm dist-tag ${process.argv[2]} is not a string`);
        }
        process.stdout.write(value || "");
      ' "${output_file}" "${NPM_DIST_TAG}"
      return 0
    fi
    if grep -Eiq "E404|404 Not Found|is not in this registry" "${output_file}"; then
      return 0
    fi
    sed -n '1,120p' "${output_file}" >&2
    if [ "${attempt}" = 3 ]; then
      echo "::error::Failed to inspect npm dist-tag ${NPM_DIST_TAG} after three attempts; refusing to publish without a channel monotonicity check." >&2
      exit "${status}"
    fi
    sleep "$((attempt * 5))"
  done
}

ensure_npm_dist_tag_will_not_regress() {
  local current_version
  local comparison
  local comparison_status

  current_version="$(read_current_npm_dist_tag)"
  if [ -z "${current_version}" ]; then
    echo "npm dist-tag ${NPM_DIST_TAG} is not set; the new release may initialize it."
    return 0
  fi

  set +e
  comparison="$(node -e '
    const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
    function parse(value) {
      const match = SEMVER.exec(value);
      if (!match) throw new Error(`invalid SemVer: ${value}`);
      return {
        core: match.slice(1, 4).map(Number),
        pre: match[4] === undefined ? null : match[4].split("."),
      };
    }
    function compareIdentifier(left, right) {
      const leftNumeric = /^\d+$/.test(left);
      const rightNumeric = /^\d+$/.test(right);
      if (leftNumeric && rightNumeric) return Number(left) - Number(right);
      if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
      return left === right ? 0 : left < right ? -1 : 1;
    }
    function compare(leftValue, rightValue) {
      const left = parse(leftValue);
      const right = parse(rightValue);
      for (let index = 0; index < 3; index += 1) {
        if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
      }
      if (left.pre === null || right.pre === null) {
        if (left.pre === right.pre) return 0;
        return left.pre === null ? 1 : -1;
      }
      const length = Math.max(left.pre.length, right.pre.length);
      for (let index = 0; index < length; index += 1) {
        if (left.pre[index] === undefined) return -1;
        if (right.pre[index] === undefined) return 1;
        const result = compareIdentifier(left.pre[index], right.pre[index]);
        if (result !== 0) return result;
      }
      return 0;
    }
    process.stdout.write(String(Math.sign(compare(process.argv[1], process.argv[2]))));
  ' "${current_version}" "${RELEASE_VERSION}" 2>&1)"
  comparison_status=$?
  set -e
  if [ "${comparison_status}" != 0 ]; then
    echo "${comparison}" >&2
    echo "::error::Could not compare npm dist-tag ${NPM_DIST_TAG} value ${current_version} with ${RELEASE_VERSION}; refusing to publish."
    exit 1
  fi

  case "${comparison}" in
    1)
      echo "::error::Refusing to move npm dist-tag ${NPM_DIST_TAG} backwards from ${current_version} to ${RELEASE_VERSION}. Another release has already advanced this channel."
      exit 1
      ;;
    0)
      echo "::error::npm dist-tag ${NPM_DIST_TAG} already points to ${RELEASE_VERSION}, but npm reports that version as absent. Refusing to publish against inconsistent registry metadata."
      exit 1
      ;;
    -1)
      echo "npm dist-tag ${NPM_DIST_TAG} currently points to ${current_version}; advancing it to ${RELEASE_VERSION} is allowed."
      ;;
    *)
      echo "::error::Unexpected SemVer comparison result: ${comparison}."
      exit 1
      ;;
  esac
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
  local local_content_fingerprint
  local registry_content_fingerprint

  mkdir -p "${verify_directory}"
  bash "${script_directory}/retry.sh" --label "download published npm package" -- \
    bash -euo pipefail -c 'npm pack "$1" --json --silent --pack-destination "$2" --prefer-online --fetch-retries=0 --fetch-timeout=8000 --registry="$4" > "$3"' \
    _ "${PACKAGE_NAME}@${RELEASE_VERSION}" "${verify_directory}" "${verify_json}" "${npm_registry_url}"
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

  archive_content_fingerprint() {
    local archive="$1"
    local listing="${RUNNER_TEMP}/memos-local-plugin-archive-listing.txt"
    tar -tzf "${archive}" \
      | awk '!/\/$/' \
      | LC_ALL=C sort > "${listing}"
    while IFS= read -r entry; do
      printf '%s\0' "${entry}"
      tar -xOf "${archive}" "${entry}" | sha256sum | awk '{print $1}'
    done < "${listing}" | sha256sum | awk '{print $1}'
  }

  local_content_fingerprint="$(archive_content_fingerprint "${RELEASE_TARBALL}")"
  registry_content_fingerprint="$(archive_content_fingerprint "${verify_tarball}")"
  if [ "${local_content_fingerprint}" != "${registry_content_fingerprint}" ]; then
    echo "::error::The npm registry tarball content does not match the locally validated release tarball. Refusing to create or recover a tag for different source content."
    exit 1
  fi
}

published_version_visible=false
published_version_preexisting=false
if npm_version_exists; then
  published_version_visible=true
  published_version_preexisting=true
  if [ "${RECOVER_EXISTING_NPM_RELEASE:-false}" != "true" ]; then
    echo "::error::${PACKAGE_NAME}@${RELEASE_VERSION} already exists. Normal releases require an unused version; enable recovery only after release-owner verification of a partial failure."
    exit 1
  fi
  if remote_tag_exists "${RELEASE_TAG}"; then
    echo "Recovery mode enabled; the existing npm version and tag will be verified and reused."
  else
    echo "Recovery mode enabled; npm version exists and the missing tag may be reconstructed after package verification."
  fi
else
  if [ "${release_metadata_state}" != "fresh" ]; then
    if [ "${allow_staged_tag_before_npm}" != "true" ]; then
      echo "::error::Tag state is ${release_metadata_state}, but ${PACKAGE_NAME}@${RELEASE_VERSION} is absent from npm. Refusing to publish after tag metadata already exists."
      exit 1
    fi
    echo "::notice::Tag state is ${release_metadata_state}; publishing npm after a staged paired local-plugin Draft Release."
  fi

  ensure_npm_dist_tag_will_not_regress

  if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
    echo "::error::NPM_TOKEN is missing; refusing a real npm publish."
    exit 1
  fi
  auth_log="${RUNNER_TEMP}/memos-local-plugin-npm-whoami.log"
  set +e
  npm whoami \
    --registry="${npm_registry_url}" \
    --fetch-retries=0 \
    --fetch-timeout=8000 \
    >"${auth_log}" 2>&1
  auth_status=$?
  set -e
  if [ "${auth_status}" != 0 ]; then
    sed -n '1,80p' "${auth_log}"
    echo "::error::NPM_TOKEN authentication failed before publish; no package request was sent."
    exit 1
  fi
  echo "Authenticated to the public npm registry as $(tr -d '[:space:]' <"${auth_log}")."

  attempt_directory="${RUNNER_TEMP}/memos-local-plugin-npm-publish-attempts"
  mkdir -p "${attempt_directory}"
  set +e
  npm publish "${RELEASE_TARBALL}" \
    --access public \
    --tag "${NPM_DIST_TAG}" \
    --registry="${npm_registry_url}" \
    --fetch-retries=0 \
    --fetch-timeout=120000 \
    >"${attempt_directory}/1.log" 2>&1
  publish_status=$?
  set -e
  sed -n '1,160p' "${attempt_directory}/1.log"

  metadata_log="${attempt_directory}/registry-verification.log"
  set +e
  wait_for_fresh_npm_release_metadata 2>&1 | tee "${metadata_log}"
  metadata_status="${PIPESTATUS[0]}"
  set -e
  if [ "${metadata_status}" = 0 ]; then
    published_version_visible=true
    if [ "${publish_status}" = 0 ]; then
      echo "npm publish and the bounded registry visibility check both succeeded."
    else
      echo "Publish returned an error, but npm now contains the fully verified release. No second publish request was sent."
    fi
  else
    RELEASE_FAILURE_PHASE=npm-publish-verification \
      RELEASE_FAILURE_ATTEMPT_DIR="${attempt_directory}" \
      node "${script_directory}/draft-local-plugin-release-notes.mjs" \
      || echo "::warning::Failed to send the exhausted-retry notification."
    if [ "${metadata_status}" = 2 ]; then
      echo "::error::npm exposed immutable integrity metadata that does not match the validated tarball. Refusing tag and Release creation."
    elif [ "${publish_status}" = 0 ]; then
      echo "::error::npm publish returned success, but version, integrity, and dist-tag were not all visible within ${npm_visibility_timeout_seconds}s. Refusing to issue a second publish request; use recovery only after inspecting npm."
    else
      echo "::error::npm publish returned an error and no fully verified release became visible within ${npm_visibility_timeout_seconds}s. Refusing an automatic second publish request; inspect npm before recovery."
    fi
    exit 1
  fi
fi

if [ "${published_version_visible}" = "true" ]; then
  verify_published_package
  if [ "${published_version_preexisting}" = "true" ] && npm_dist_tag_matches; then
    echo "Existing npm dist-tag ${NPM_DIST_TAG} still points to ${RELEASE_VERSION}."
  elif [ "${published_version_preexisting}" = "true" ]; then
    echo "::notice::Existing npm version ${RELEASE_VERSION} was verified, but mutable dist-tag ${NPM_DIST_TAG} now points elsewhere. Leaving it unchanged during recovery/idempotent rerun."
  fi
else
  echo "::error::Internal error: npm package visibility was not established."
  exit 1
fi
