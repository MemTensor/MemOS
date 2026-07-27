import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const publishScript = join(scriptDirectory, "publish-local-plugin.sh");

const mockNpm = `#!/usr/bin/env bash
set -euo pipefail

increment_counter() {
  local name="$1"
  local counter_file="\${NPM_MOCK_STATE_DIR}/\${name}"
  local count=0
  if [ -f "\${counter_file}" ]; then
    count="$(cat "\${counter_file}")"
  fi
  count=$((count + 1))
  printf '%s' "\${count}" > "\${counter_file}"
  printf '%s' "\${count}"
}

case "\${1:-}" in
  view)
    view_count="$(increment_counter view)"
    if [ "\${NPM_MOCK_SCENARIO}" = "eventually-visible" ] && [ "\${view_count}" -ge 4 ]; then
      printf '%s\\n' "\${RELEASE_VERSION}"
      exit 0
    fi
    echo "npm error code E404" >&2
    echo "npm error 404 Not Found - \${PACKAGE_NAME}@\${RELEASE_VERSION}" >&2
    exit 1
    ;;
  publish)
    increment_counter publish >/dev/null
    if [ "\${NPM_MOCK_SCENARIO}" = "publish-fails" ]; then
      echo "npm error code E500" >&2
      exit 1
    fi
    echo "+ \${PACKAGE_NAME}@\${RELEASE_VERSION}"
    exit 0
    ;;
  *)
    echo "Unexpected npm command: $*" >&2
    exit 2
    ;;
esac
`;

function readCounter(stateDirectory, name) {
  try {
    return Number(readFileSync(join(stateDirectory, name), "utf8"));
  } catch {
    return 0;
  }
}

function runScenario(scenario, overrides = {}) {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "memos-local-plugin-publish-"));
  const binDirectory = join(fixtureDirectory, "bin");
  const stateDirectory = join(fixtureDirectory, "state");
  mkdirSync(binDirectory);
  mkdirSync(stateDirectory);

  const npmPath = join(binDirectory, "npm");
  writeFileSync(npmPath, mockNpm, "utf8");
  chmodSync(npmPath, 0o755);

  const result = spawnSync("bash", [publishScript], {
    cwd: fixtureDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      RUNNER_TEMP: fixtureDirectory,
      PACKAGE_NAME: "@memtensor/memos-local-plugin",
      RELEASE_VERSION: "2.0.12",
      RELEASE_TAG: "memos-local-plugin-v2.0.12",
      NPM_DIST_TAG: "latest",
      RECOVER_EXISTING_NPM_RELEASE: "false",
      DOC_AGENT_RELEASE_FAILURE_URL: "",
      DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN: "",
      NPM_MOCK_SCENARIO: scenario,
      NPM_MOCK_STATE_DIR: stateDirectory,
      NPM_VISIBILITY_ATTEMPTS: "3",
      NPM_AMBIGUOUS_VISIBILITY_ATTEMPTS: "2",
      NPM_VISIBILITY_DELAY_SECONDS: "0",
      ...overrides,
    },
  });

  const outcome = {
    ...result,
    viewCount: readCounter(stateDirectory, "view"),
    publishCount: readCounter(stateDirectory, "publish"),
  };
  rmSync(fixtureDirectory, { recursive: true, force: true });
  return outcome;
}

test("waits through two post-publish 404 responses before the version becomes visible", () => {
  const result = runScenario("eventually-visible");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishCount, 1);
  assert.equal(result.viewCount, 4);
  assert.match(result.stdout, /became visible on attempt 3/);
});

test("continues release metadata creation when publish succeeds but visibility remains delayed", () => {
  const result = runScenario("always-missing");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishCount, 1);
  assert.equal(result.viewCount, 4);
  assert.match(result.stdout, /npm publish succeeded.*continuing with tag, Release, and PR creation/s);
});

test("fails when publish fails and the requested version remains absent", () => {
  const result = runScenario("publish-fails");

  assert.notEqual(result.status, 0);
  assert.equal(result.publishCount, 3);
  assert.match(result.stdout + result.stderr, /npm publish failed after three attempts/);
});
