import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MEMOS_PACKAGE_INIT_PATH,
  MEMOS_PYPROJECT_PATH,
  assertMemOSVersionTexts,
  compareStableMemOSVersions,
  expectedReleaseBranches,
  inspectMemOSVersionTexts,
  normalizeStableMemOSVersion,
  updateMemOSVersionFiles,
  updateMemOSVersionTexts,
} from "./memos-version.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workflowsDir = join(__dirname, "../workflows");

function versionTexts(version = "2.0.29") {
  return {
    pyprojectText: `[project]\nname = "MemoryOS"\nversion = "${version}"\ndescription = "test"\n`,
    packageInitText: `__version__ = "${version}"\n\nfrom memos.example import Example\n`,
  };
}

test("accepts only stable MemOS versions without a leading v", () => {
  assert.equal(normalizeStableMemOSVersion("2.0.30"), "2.0.30");
  assert.deepEqual(expectedReleaseBranches("2.0.30"), {
    sourceBranch: "dev-v2.0.30",
    releaseBranch: "release/v2.0.30",
  });

  for (const invalid of [
    "",
    "v2.0.30",
    "2.0",
    "2.0.30-beta.1",
    "2.0.30+build.1",
    "02.0.30",
    "2.0.30; echo unsafe",
  ]) {
    assert.throws(
      () => normalizeStableMemOSVersion(invalid),
      /stable X\.Y\.Z|leading v|required/,
    );
  }
});

test("compares stable MemOS versions without numeric precision loss", () => {
  assert.ok(compareStableMemOSVersions("2.0.30", "2.0.29") > 0);
  assert.ok(compareStableMemOSVersions("10.0.0", "2.99.99") > 0);
  assert.ok(
    compareStableMemOSVersions(
      "2.0.10000000000000000000",
      "2.0.9999999999999999999",
    ) > 0,
  );
  assert.equal(compareStableMemOSVersions("2.0.30", "2.0.30"), 0);
});

test("updates both MemOS version declarations and preserves surrounding content", () => {
  const current = versionTexts();
  const result = updateMemOSVersionTexts({
    expectedVersion: "2.0.30",
    ...current,
  });

  assert.equal(result.previousVersion, "2.0.29");
  assert.equal(result.version, "2.0.30");
  assert.equal(result.changed, true);
  assert.equal(
    result.pyprojectText,
    `[project]\nname = "MemoryOS"\nversion = "2.0.30"\ndescription = "test"\n`,
  );
  assert.equal(
    result.packageInitText,
    `__version__ = "2.0.30"\n\nfrom memos.example import Example\n`,
  );
});

test("updates only the version in the pyproject project section", () => {
  const result = updateMemOSVersionTexts({
    expectedVersion: "2.0.30",
    pyprojectText: `[project]\nversion = "2.0.29"\n\n[example]\nversion = "9.9.9"\n\n[[example.index]]\nversion = "8.8.8"\n`,
    packageInitText: `__version__ = "2.0.29"\n`,
  });

  assert.equal(
    result.pyprojectText,
    `[project]\nversion = "2.0.30"\n\n[example]\nversion = "9.9.9"\n\n[[example.index]]\nversion = "8.8.8"\n`,
  );
});

test("is idempotent when both declarations already match", () => {
  const current = versionTexts("2.0.30");
  const result = updateMemOSVersionTexts({
    expectedVersion: "2.0.30",
    ...current,
  });

  assert.equal(result.changed, false);
  assert.equal(result.previousVersion, "2.0.30");
  assert.deepEqual(inspectMemOSVersionTexts(current), {
    pyprojectVersion: "2.0.30",
    packageVersion: "2.0.30",
    version: "2.0.30",
  });
});

test("fails closed for mismatched, malformed, duplicate, or downgraded versions", () => {
  assert.throws(
    () =>
      inspectMemOSVersionTexts({
        ...versionTexts(),
        packageInitText: `__version__ = "2.0.28"\n`,
      }),
    /do not match/,
  );
  assert.throws(
    () =>
      inspectMemOSVersionTexts({
        ...versionTexts(),
        pyprojectText: `[project]\nversion = "2.0.29"\nversion = "2.0.30"\n`,
      }),
    /exactly one/,
  );
  assert.throws(
    () =>
      inspectMemOSVersionTexts({
        ...versionTexts(),
        pyprojectText: `[project]\nversion = "2.0.29"\nversion='2.0.30'\n`,
      }),
    /exactly one version assignment/,
  );
  assert.throws(
    () =>
      inspectMemOSVersionTexts({
        ...versionTexts(),
        packageInitText: `__version__ = "2.0.29"\n__version__='1.0.0'\n`,
      }),
    /exactly one __version__ identifier/,
  );
  assert.throws(
    () =>
      inspectMemOSVersionTexts({
        ...versionTexts(),
        packageInitText: `__version__ = "2.0.29"; __version__ = "1.0.0"\n`,
      }),
    /exactly one __version__ identifier/,
  );
  assert.throws(
    () =>
      inspectMemOSVersionTexts({
        ...versionTexts(),
        packageInitText: `__version__ = "2.0.29"\nif True: __version__ = "1.0.0"\n`,
      }),
    /exactly one __version__ identifier/,
  );
  assert.throws(
    () =>
      updateMemOSVersionTexts({ expectedVersion: "2.0.28", ...versionTexts() }),
    /must be newer/,
  );
  assert.throws(
    () =>
      assertMemOSVersionTexts({ expectedVersion: "2.0.30", ...versionTexts() }),
    /expected 2\.0\.30/,
  );
});

test("updates the repository files as one version pair", () => {
  const root = mkdtempSync(join(tmpdir(), "memos-version-test-"));
  const current = versionTexts();
  const pyprojectPath = join(root, MEMOS_PYPROJECT_PATH);
  const packageInitPath = join(root, MEMOS_PACKAGE_INIT_PATH);
  mkdirSync(dirname(packageInitPath), { recursive: true });
  writeFileSync(pyprojectPath, current.pyprojectText);
  writeFileSync(packageInitPath, current.packageInitText);

  const result = updateMemOSVersionFiles({ root, expectedVersion: "2.0.30" });

  assert.equal(result.changed, true);
  assert.match(readFileSync(pyprojectPath, "utf8"), /^version = "2\.0\.30"$/m);
  assert.match(
    readFileSync(packageInitPath, "utf8"),
    /^__version__ = "2\.0\.30"$/m,
  );
});

test("runs from a trusted copy reached through a symbolic path", () => {
  const root = mkdtempSync(join(tmpdir(), "memos-version-cli-test-"));
  const realDirectory = join(root, "real");
  const linkedDirectory = join(root, "linked");
  const outputPath = join(root, "output.txt");
  mkdirSync(realDirectory);
  symlinkSync(realDirectory, linkedDirectory, "dir");
  copyFileSync(
    join(__dirname, "memos-version.mjs"),
    join(realDirectory, "memos-version.mjs"),
  );

  const result = spawnSync(
    process.execPath,
    [join(linkedDirectory, "memos-version.mjs"), "plan"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RELEASE_VERSION: "2.0.30",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(outputPath, "utf8"), /^version=2\.0\.30$/m);
  assert.match(
    readFileSync(outputPath, "utf8"),
    /^source_branch=dev-v2\.0\.30$/m,
  );
  assert.match(
    readFileSync(outputPath, "utf8"),
    /^release_branch=release\/v2\.0\.30$/m,
  );
});

test("prepare workflow creates a guarded release branch and manual PR handoff without touching dev", () => {
  const workflow = readFileSync(
    join(workflowsDir, "memos-release-prepare.yml"),
    "utf8",
  );

  assert.match(workflow, /name: MemOS Release — Prepare/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /permissions:\n\s+contents: write\n\s+pull-requests: read/,
  );
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /SELECTED_BRANCH: \$\{\{ github\.ref_name \}\}/);
  assert.match(workflow, /SELECTED_REF: \$\{\{ github\.ref \}\}/);
  assert.match(workflow, /SELECTED_REF_TYPE: \$\{\{ github\.ref_type \}\}/);
  assert.match(workflow, /expected_ref="refs\/heads\/\$\{DEFAULT_BRANCH\}"/);
  assert.match(
    workflow,
    /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/,
  );
  assert.match(workflow, /RELEASE_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(workflow, /node "\$\{RUNNER_TEMP\}\/memos-version\.mjs"/);
  assert.match(workflow, /refs\/heads\/\$\{SOURCE_BRANCH\}/);
  assert.match(workflow, /refs\/heads\/\$\{RELEASE_BRANCH\}/);
  assert.match(workflow, /merge-base --is-ancestor/);
  assert.match(workflow, /merged_branch_deleted/);
  assert.match(workflow, /require-newer/);
  assert.match(workflow, /assert_release_matches_trusted_update/);
  assert.match(workflow, /cmp -s/);
  assert.match(workflow, /git diff --name-only/);
  assert.match(workflow, /pyproject\.toml/);
  assert.match(workflow, /src\/memos\/__init__\.py/);
  assert.match(
    workflow,
    /chore: change version number to v\$\{RELEASE_VERSION\}/,
  );
  assert.match(workflow, /gh pr list/);
  assert.match(workflow, /The PR is intentionally opened by a maintainer/);
  assert.doesNotMatch(workflow, /gh pr create/);
  assert.match(
    workflow,
    /compare\/\$\{DEFAULT_BRANCH\}\.\.\.\$\{RELEASE_BRANCH\}/,
  );
  assert.doesNotMatch(
    workflow,
    /git push[^\n]*refs\/heads\/\$\{SOURCE_BRANCH\}/,
  );
  assert.doesNotMatch(workflow, /--force/);
  assert.doesNotMatch(workflow, /run:[^\n]*\$\{\{ inputs\./);
});

test("publish inspection fails closed unless the target ref contains the requested package version", () => {
  const publishScript = readFileSync(
    join(__dirname, "prepare-memos-release.mjs"),
    "utf8",
  );
  const publishWorkflow = readFileSync(
    join(workflowsDir, "memos-release-publish-main.yml"),
    "utf8",
  );

  assert.match(publishScript, /assertMemOSVersionTexts/);
  assert.match(publishScript, /target\.sha/);
  assert.match(publishScript, /MEMOS_PYPROJECT_PATH/);
  assert.match(publishScript, /MEMOS_PACKAGE_INIT_PATH/);
  assert.match(publishWorkflow, /memos-version\.test\.mjs/);
  assert.match(publishScript, /"refs\/remotes\/origin\/main"/);
  assert.equal(
    existsSync(join(workflowsDir, "memos-release-publish.yml")),
    false,
    "the legacy path must remain absent so old dev workflow revisions cannot be dispatched",
  );
  assert.match(
    publishWorkflow,
    /SELECTED_BRANCH: \$\{\{ github\.ref_name \}\}/,
  );
  assert.match(publishWorkflow, /SELECTED_REF: \$\{\{ github\.ref \}\}/);
  assert.match(
    publishWorkflow,
    /SELECTED_REF_TYPE: \$\{\{ github\.ref_type \}\}/,
  );
  assert.match(
    publishWorkflow,
    /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/,
  );
});
