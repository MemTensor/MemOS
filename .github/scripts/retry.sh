#!/usr/bin/env bash
set -euo pipefail

attempts="${RETRY_ATTEMPTS:-3}"
delay="${RETRY_DELAY_SECONDS:-5}"
label="command"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --attempts)
      attempts="$2"
      shift 2
      ;;
    --delay)
      delay="$2"
      shift 2
      ;;
    --label)
      label="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -eq 0 ]; then
  echo "::error::retry.sh requires a command to run." >&2
  exit 2
fi

if ! [[ "${attempts}" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::Invalid retry attempts: ${attempts}" >&2
  exit 2
fi

if ! [[ "${delay}" =~ ^[0-9]+$ ]]; then
  echo "::error::Invalid retry delay: ${delay}" >&2
  exit 2
fi

for attempt in $(seq 1 "${attempts}"); do
  echo "::group::${label} attempt ${attempt}/${attempts}" >&2
  set +e
  "$@"
  status=$?
  set -e
  echo "::endgroup::" >&2

  if [ "${status}" -eq 0 ]; then
    exit 0
  fi

  if [ "${attempt}" -eq "${attempts}" ]; then
    echo "::error::${label} failed after ${attempts} attempts with exit code ${status}." >&2
    exit "${status}"
  fi

  sleep_seconds=$((delay * attempt))
  echo "::warning::${label} failed with exit code ${status}; retrying in ${sleep_seconds}s." >&2
  sleep "${sleep_seconds}"
done
