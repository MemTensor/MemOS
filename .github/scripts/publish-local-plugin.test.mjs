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
    if [ "\${3:-}" = "dist-tags" ]; then
      increment_counter dist_tag >/dev/null
      printf '{"%s":"%s"}\n' "\${NPM_DIST_TAG}" "\${NPM_MOCK_DIST_TAG_VERSION:-\${RELEASE_VERSION}}"
      exit 0
    fi
    view_count="$(increment_counter view)"
    if [ "\${NPM_MOCK_SCENARIO}" = "already-visible" ] || { { [ "\${NPM_MOCK_SCENARIO}" = "eventually-visible" ] || [ "\${NPM_MOCK_SCENARIO}" = "publish-error-eventually-visible" ]; } && [ "\${view_count}" -ge 4 ]; }; then
      printf '%s\\n' "\${RELEASE_VERSION}"
      exit 0
    fi
    echo "npm error code E404" >&2
    echo "npm error 404 Not Found - \${PACKAGE_NAME}@\${RELEASE_VERSION}" >&2
    exit 1
    ;;
  publish)
    increment_counter publish >/dev/null
    printf '%s' "\${2:-}" > "\${NPM_MOCK_STATE_DIR}/published-argument"
    printf '%s' "$*" > "\${NPM_MOCK_STATE_DIR}/publish-arguments"
    if [ "\${NPM_MOCK_SCENARIO}" = "publish-fails" ] || [ "\${NPM_MOCK_SCENARIO}" = "publish-error-eventually-visible" ]; then
      echo "npm error code E500" >&2
      exit 1
    fi
    echo "+ \${PACKAGE_NAME}@\${RELEASE_VERSION}"
    exit 0
    ;;
  pack)
    increment_counter pack >/dev/null
    destination=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--pack-destination" ]; then
        destination="$2"
        shift 2
        continue
      fi
      shift
    done
    if [ -z "\${destination}" ]; then
      echo "Missing --pack-destination" >&2
      exit 2
    fi
    pack_root="\${NPM_MOCK_STATE_DIR}/pack-root"
    filename="memtensor-memos-local-plugin-\${RELEASE_VERSION}.tgz"
    rm -rf "\${pack_root}"
    mkdir -p "\${pack_root}/package/adapters/hermes" "\${destination}"
    printf '{"name":"%s","version":"%s"}\\n' \
      "\${PACKAGE_NAME}" "\${RELEASE_VERSION}" \
      > "\${pack_root}/package/package.json"
    printf 'version: %s\\n' \
      "\${NPM_MOCK_MANIFEST_VERSION:-\${RELEASE_VERSION}}" \
      > "\${pack_root}/package/adapters/hermes/plugin.yaml"
    if [ -n "\${NPM_MOCK_EXTRA_CONTENT:-}" ]; then
      printf '%s\\n' "\${NPM_MOCK_EXTRA_CONTENT}" > "\${pack_root}/package/registry-only.txt"
    fi
    tar -czf "\${destination}/\${filename}" -C "\${pack_root}" package
    printf '[{"filename":"%s"}]\\n' "\${filename}"
    exit 0
    ;;
  *)
    echo "Unexpected npm command: $*" >&2
    exit 2
    ;;
esac
`;

const mockGit = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "ls-remote" ]; then
  exit 2
fi
echo "Unexpected git command: $*" >&2
exit 2
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
  const gitPath = join(binDirectory, "git");
  const releaseTarball = join(fixtureDirectory, "release.tgz");
  writeFileSync(npmPath, mockNpm, "utf8");
  chmodSync(npmPath, 0o755);
  writeFileSync(gitPath, mockGit, "utf8");
  chmodSync(gitPath, 0o755);
  const localPackRoot = join(fixtureDirectory, "local-pack-root");
  mkdirSync(join(localPackRoot, "package", "adapters", "hermes"), { recursive: true });
  writeFileSync(
    join(localPackRoot, "package", "package.json"),
    '{"name":"@memtensor/memos-local-plugin","version":"2.0.12"}\n',
    "utf8",
  );
  writeFileSync(
    join(localPackRoot, "package", "adapters", "hermes", "plugin.yaml"),
    "version: 2.0.12\n",
    "utf8",
  );
  spawnSync("tar", ["-czf", releaseTarball, "-C", localPackRoot, "package"], {
    encoding: "utf8",
  });

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
      RELEASE_TARBALL: releaseTarball,
      RECOVER_EXISTING_NPM_RELEASE: "false",
      DOC_AGENT_RELEASE_FAILURE_URL: "",
      DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN: "",
      NPM_MOCK_SCENARIO: scenario,
      NPM_MOCK_STATE_DIR: stateDirectory,
      NPM_VISIBILITY_ATTEMPTS: "3",
      NPM_AMBIGUOUS_VISIBILITY_ATTEMPTS: "3",
      NPM_VISIBILITY_DELAY_SECONDS: "0",
      ...overrides,
    },
  });

  const outcome = {
    ...result,
    viewCount: readCounter(stateDirectory, "view"),
    publishCount: readCounter(stateDirectory, "publish"),
    packCount: readCounter(stateDirectory, "pack"),
    publishedArgument: (() => {
      try {
        return readFileSync(join(stateDirectory, "published-argument"), "utf8");
      } catch {
        return "";
      }
    })(),
    publishArguments: (() => {
      try {
        return readFileSync(join(stateDirectory, "publish-arguments"), "utf8");
      } catch {
        return "";
      }
    })(),
  };
  rmSync(fixtureDirectory, { recursive: true, force: true });
  return outcome;
}

test("waits through two post-publish 404 responses before the version becomes visible", () => {
  const result = runScenario("eventually-visible");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishCount, 1);
  assert.equal(result.viewCount, 4);
  assert.equal(result.packCount, 1);
  assert.match(result.publishedArgument, /release\.tgz$/);
  assert.match(result.publishArguments, /--fetch-retries=0/);
  assert.match(result.stdout, /became visible on attempt 3/);
});

test("stops before release metadata when publish succeeds but visibility remains delayed", () => {
  const result = runScenario("always-missing");

  assert.notEqual(result.status, 0);
  assert.equal(result.publishCount, 1);
  assert.equal(result.viewCount, 4);
  assert.equal(result.packCount, 0);
  assert.match(result.stdout + result.stderr, /Stop before tag\/Release creation/);
});

test("fails when publish fails and the requested version remains absent", () => {
  const result = runScenario("publish-fails");

  assert.notEqual(result.status, 0);
  assert.equal(result.publishCount, 1);
  assert.match(result.stdout + result.stderr, /Refusing an automatic second publish request/);
});

test("does not issue a second publish when an error becomes visible after propagation", () => {
  const result = runScenario("publish-error-eventually-visible");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishCount, 1);
  assert.equal(result.packCount, 1);
  assert.match(result.stdout, /No second publish request was sent/);
});

test("fails when the requested npm dist-tag points to another version", () => {
  const result = runScenario("eventually-visible", {
    NPM_MOCK_DIST_TAG_VERSION: "2.0.11",
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.publishCount, 1);
  assert.match(result.stdout + result.stderr, /did not point to 2\.0\.12/);
});

test("fails when the published Hermes manifest version differs", () => {
  const result = runScenario("eventually-visible", {
    NPM_MOCK_MANIFEST_VERSION: "2.0.11",
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.packCount, 1);
  assert.match(
    result.stdout + result.stderr,
    /Published Hermes manifest version 2\.0\.11 does not match 2\.0\.12/,
  );
});

test("fails recovery when registry package content differs from the validated tarball", () => {
  const result = runScenario("eventually-visible", {
    NPM_MOCK_EXTRA_CONTENT: "different package content",
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.packCount, 1);
  assert.match(
    result.stdout + result.stderr,
    /registry tarball content does not match the locally validated release tarball/,
  );
});

test("does not require a mutable dist-tag to point to an older preexisting version", () => {
  const result = runScenario("already-visible", {
    RECOVER_EXISTING_NPM_RELEASE: "true",
    RELEASE_METADATA_STATE: "fresh",
    NPM_MOCK_DIST_TAG_VERSION: "2.0.13",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishCount, 0);
  assert.equal(result.packCount, 1);
  assert.match(result.stdout, /mutable dist-tag latest now points elsewhere/);
});
