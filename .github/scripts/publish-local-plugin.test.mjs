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
      if [ "\${NPM_MOCK_SCENARIO}" = "dist-tag-lookup-fails" ]; then
        echo "npm error code E500" >&2
        exit 1
      fi
      if [ "\${NPM_MOCK_DIST_TAGS_EMPTY:-false}" = "true" ]; then
        printf '{}\n'
        exit 0
      elif [ "\${NPM_MOCK_SCENARIO}" = "already-visible" ]; then
        dist_tag_version="\${NPM_MOCK_DIST_TAG_VERSION:-\${RELEASE_VERSION}}"
      else
        dist_tag_version="\${NPM_MOCK_PREFLIGHT_DIST_TAG_VERSION:-2.0.11}"
      fi
      printf '{"%s":"%s"}\n' "\${NPM_DIST_TAG}" "\${dist_tag_version}"
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
  whoami)
    increment_counter whoami >/dev/null
    if [ "\${NPM_MOCK_SCENARIO}" = "auth-fails" ]; then
      echo "npm error code E401" >&2
      exit 1
    fi
    echo "release-bot"
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

const mockNode = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == *"wait-for-local-plugin-npm-release.mjs" ]]; then
  increment_file="\${NPM_MOCK_STATE_DIR}/metadata_wait"
  count=0
  if [ -f "\${increment_file}" ]; then count="$(cat "\${increment_file}")"; fi
  count=$((count + 1))
  printf '%s' "\${count}" > "\${increment_file}"
  case "\${NPM_MOCK_SCENARIO}" in
    always-missing|publish-fails)
      echo "::error::npm release was not fully visible within 150s"
      exit 1
      ;;
    integrity-mismatch)
      echo "::error::npm release verification failed: integrity mismatch"
      exit 2
      ;;
    *)
      if [ "\${NPM_MOCK_DIST_TAG_VERSION:-\${RELEASE_VERSION}}" != "\${RELEASE_VERSION}" ]; then
        echo "::error::npm release was not fully visible within 150s: dist-tag \${NPM_DIST_TAG} did not point to \${RELEASE_VERSION}"
        exit 1
      fi
      echo '{"ok":true,"attempts":3}'
      exit 0
      ;;
  esac
fi
exec "${process.execPath}" "$@"
`;

const mockGit = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "ls-remote" ]; then
  exit 2
fi
echo "Unexpected git command: $*" >&2
exit 2
`;

const mockSleep = `#!/usr/bin/env bash
exit 0
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
  const nodePath = join(binDirectory, "node");
  const gitPath = join(binDirectory, "git");
  const sleepPath = join(binDirectory, "sleep");
  const releaseTarball = join(fixtureDirectory, "release.tgz");
  writeFileSync(npmPath, mockNpm, "utf8");
  chmodSync(npmPath, 0o755);
  writeFileSync(nodePath, mockNode, "utf8");
  chmodSync(nodePath, 0o755);
  writeFileSync(gitPath, mockGit, "utf8");
  chmodSync(gitPath, 0o755);
  writeFileSync(sleepPath, mockSleep, "utf8");
  chmodSync(sleepPath, 0o755);
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
      NODE_AUTH_TOKEN: "test-token",
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
    whoamiCount: readCounter(stateDirectory, "whoami"),
    packCount: readCounter(stateDirectory, "pack"),
    metadataWaitCount: readCounter(stateDirectory, "metadata_wait"),
    distTagCount: readCounter(stateDirectory, "dist_tag"),
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

test("publishes once and continues only after bounded registry verification", () => {
  const result = runScenario("eventually-visible");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishCount, 1);
  assert.equal(result.metadataWaitCount, 1);
  assert.equal(result.packCount, 1);
  assert.match(result.publishedArgument, /release\.tgz$/);
  assert.match(result.publishArguments, /--fetch-retries=0/);
  assert.match(result.publishArguments, /--fetch-timeout=120000/);
  assert.match(result.publishArguments, /--registry=https:\/\/registry\.npmjs\.org/);
  assert.match(result.stdout, /bounded registry visibility check both succeeded/);
});

test("fails before authentication when a newer release already owns the npm channel", () => {
  const result = runScenario("eventually-visible", {
    NPM_MOCK_PREFLIGHT_DIST_TAG_VERSION: "2.0.13",
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.distTagCount, 1);
  assert.equal(result.whoamiCount, 0);
  assert.equal(result.publishCount, 0);
  assert.equal(result.metadataWaitCount, 0);
  assert.match(result.stdout + result.stderr, /Refusing to move npm dist-tag latest backwards from 2\.0\.13 to 2\.0\.12/);
});

test("uses SemVer precedence instead of lexical order for prerelease channels", () => {
  const result = runScenario("eventually-visible", {
    RELEASE_VERSION: "2.0.12-beta.9",
    RELEASE_TAG: "memos-local-plugin-v2.0.12-beta.9",
    NPM_DIST_TAG: "beta",
    NPM_MOCK_PREFLIGHT_DIST_TAG_VERSION: "2.0.12-beta.10",
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.whoamiCount, 0);
  assert.equal(result.publishCount, 0);
  assert.match(result.stdout + result.stderr, /Refusing to move npm dist-tag beta backwards from 2\.0\.12-beta\.10 to 2\.0\.12-beta\.9/);
});

test("fails closed when npm version and dist-tag metadata contradict each other", () => {
  const result = runScenario("eventually-visible", {
    NPM_MOCK_PREFLIGHT_DIST_TAG_VERSION: "2.0.12",
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.whoamiCount, 0);
  assert.equal(result.publishCount, 0);
  assert.match(result.stdout + result.stderr, /reports that version as absent/);
});

test("fails before authentication when npm channel state cannot be inspected", () => {
  const result = runScenario("dist-tag-lookup-fails");

  assert.notEqual(result.status, 0);
  assert.equal(result.distTagCount, 3);
  assert.equal(result.whoamiCount, 0);
  assert.equal(result.publishCount, 0);
  assert.match(result.stdout + result.stderr, /refusing to publish without a channel monotonicity check/);
});

test("allows initializing an npm channel that does not exist yet", () => {
  const result = runScenario("eventually-visible", {
    NPM_MOCK_DIST_TAGS_EMPTY: "true",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishCount, 1);
  assert.match(result.stdout, /dist-tag latest is not set/);
});

test("stops before tag creation when publish succeeds but visibility remains delayed", () => {
  const result = runScenario("always-missing");

  assert.notEqual(result.status, 0);
  assert.equal(result.publishCount, 1);
  assert.equal(result.metadataWaitCount, 1);
  assert.equal(result.packCount, 0);
  assert.match(result.stdout + result.stderr, /Refusing to issue a second publish request/);
});

test("allows npm publish after a staged paired Draft Release only in npm-only phase", () => {
  const blocked = runScenario("eventually-visible", {
    RELEASE_METADATA_STATE: "complete",
  });

  assert.notEqual(blocked.status, 0);
  assert.equal(blocked.publishCount, 0);
  assert.match(blocked.stdout + blocked.stderr, /Refusing to publish after tag metadata already exists/);

  const allowed = runScenario("eventually-visible", {
    RELEASE_METADATA_STATE: "complete",
    ALLOW_STAGED_TAG_BEFORE_NPM: "true",
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.publishCount, 1);
  assert.equal(allowed.metadataWaitCount, 1);
  assert.equal(allowed.packCount, 1);
  assert.match(allowed.stdout, /publishing npm after a staged paired local-plugin Draft Release/);
});

test("fails when publish fails and the requested version remains absent", () => {
  const result = runScenario("publish-fails");

  assert.notEqual(result.status, 0);
  assert.equal(result.publishCount, 1);
  assert.equal(result.metadataWaitCount, 1);
  assert.match(result.stdout + result.stderr, /Refusing an automatic second publish request/);
});

test("fails before publish when npm authentication is invalid", () => {
  const result = runScenario("auth-fails");

  assert.notEqual(result.status, 0);
  assert.equal(result.whoamiCount, 1);
  assert.equal(result.publishCount, 0);
  assert.equal(result.metadataWaitCount, 0);
  assert.match(result.stdout + result.stderr, /authentication failed before publish/);
});

test("fails before npm authentication when NPM_TOKEN is missing", () => {
  const result = runScenario("eventually-visible", { NODE_AUTH_TOKEN: "" });

  assert.notEqual(result.status, 0);
  assert.equal(result.whoamiCount, 0);
  assert.equal(result.publishCount, 0);
  assert.equal(result.metadataWaitCount, 0);
  assert.match(result.stdout + result.stderr, /NPM_TOKEN is missing/);
});

test("does not issue a second publish when an error becomes visible after propagation", () => {
  const result = runScenario("publish-error-eventually-visible");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishCount, 1);
  assert.equal(result.metadataWaitCount, 1);
  assert.equal(result.packCount, 1);
  assert.match(result.stdout, /No second publish request was sent/);
});

test("stops immediately when registry integrity conflicts with the validated tarball", () => {
  const result = runScenario("integrity-mismatch");

  assert.notEqual(result.status, 0);
  assert.equal(result.publishCount, 1);
  assert.equal(result.metadataWaitCount, 1);
  assert.equal(result.packCount, 0);
  assert.match(result.stdout + result.stderr, /immutable integrity metadata/);
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

test("rejects an already-used npm version outside explicit recovery", () => {
  const result = runScenario("already-visible", {
    RECOVER_EXISTING_NPM_RELEASE: "false",
    RELEASE_METADATA_STATE: "fresh",
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.publishCount, 0);
  assert.equal(result.packCount, 0);
  assert.match(result.stdout + result.stderr, /Normal releases require an unused version/);
});
