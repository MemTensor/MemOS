#!/usr/bin/env bash
set -euo pipefail

attempts="${RETRY_ATTEMPTS:-3}"
delay="${RETRY_DELAY_SECONDS:-5}"
max_delay="${RETRY_MAX_DELAY_SECONDS:-60}"
attempt_dir="${RETRY_ATTEMPT_DIR:-}"
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
    --max-delay)
      max_delay="$2"
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

if ! [[ "${max_delay}" =~ ^[0-9]+$ ]]; then
  echo "::error::Invalid retry max delay: ${max_delay}" >&2
  exit 2
fi

if [ -n "${attempt_dir}" ]; then
  mkdir -p "${attempt_dir}"
fi

for attempt in $(seq 1 "${attempts}"); do
  echo "::group::${label} attempt ${attempt}/${attempts}" >&2
  set +e
  if [ -n "${attempt_dir}" ]; then
    "$@" >"${attempt_dir}/${attempt}.log" 2>&1
    status=$?
    sed -n '1,160p' "${attempt_dir}/${attempt}.log"
  else
    "$@"
    status=$?
  fi
  set -e
  echo "::endgroup::" >&2

  if [ "${status}" -eq 0 ]; then
    exit 0
  fi

  if [ "${attempt}" -eq "${attempts}" ]; then
    echo "::error::${label} failed after ${attempts} attempts with exit code ${status}." >&2
    exit "${status}"
  fi

  base_sleep=$((delay * (2 ** (attempt - 1))))
  if [ "${base_sleep}" -gt "${max_delay}" ]; then
    base_sleep="${max_delay}"
  fi

  jitter=0
  if [ "${base_sleep}" -gt 0 ]; then
    jitter=$((RANDOM % (base_sleep + 1)))
  fi
  sleep_seconds=$((base_sleep + jitter))
  if [ "${sleep_seconds}" -gt "${max_delay}" ]; then
    sleep_seconds="${max_delay}"
  fi

  echo "::warning::${label} failed with exit code ${status}; retrying in ${sleep_seconds}s." >&2
  sleep "${sleep_seconds}"
done
