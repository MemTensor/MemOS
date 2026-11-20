import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DOC_AGENT_SOURCE_ID,
  docAgentSourceIds,
  inspectReleaseInventory,
} from "./validate-github-release-inventory.mjs";

function release(overrides = {}) {
  return {
    id: 149,
    tag_name: "v0.1.20",
    draft: false,
    prerelease: false,
    target_commitish: "abc123",
    body: `## Changelog\n\n<!-- doc-agent: source-id=${DOC_AGENT_SOURCE_ID} -->`,
    created_at: "2026-07-27T00:00:00Z",
    ...overrides,
  };
}

test("extracts exact Doc Agent source ids", () => {
  assert.deepEqual(
    docAgentSourceIds(
      "<!-- doc-agent: source-id=openclaw-cloud-plugin -->\n<!-- doc-agent: source-id=other -->",
    ),
    ["openclaw-cloud-plugin", "other"],
  );
});

test("accepts an absent release unless post-create verification requires it", () => {
  const absent = inspectReleaseInventory({
    pages: [[]],
    tag: "v0.1.20",
    expectedDraft: false,
    expectedPrerelease: false,
  });
  assert.equal(absent.ok, true);
  assert.equal(absent.state, "absent");

  const required = inspectReleaseInventory({
    pages: [[]],
    tag: "v0.1.20",
    expectedDraft: false,
    expectedPrerelease: false,
    requireExisting: true,
  });
  assert.equal(required.ok, false);
  assert.match(required.errors[0], /not visible/);
});

test("fails closed on duplicate releases including drafts", () => {
  const report = inspectReleaseInventory({
    pages: [[release(), release({ id: 150, draft: true })]],
    tag: "v0.1.20",
    expectedDraft: false,
    expectedPrerelease: false,
  });
  assert.equal(report.ok, false);
  assert.equal(report.state, "ambiguous");
  assert.match(report.errors[0], /2 GitHub Releases/);
});

test("verifies target, release flags, and the exact production source id", () => {
  const valid = inspectReleaseInventory({
    pages: [[release()]],
    tag: "v0.1.20",
    expectedDraft: false,
    expectedPrerelease: false,
    expectedTargetCommitish: "abc123",
  });
  assert.equal(valid.ok, true);

  const invalid = inspectReleaseInventory({
    pages: [[
      release({
        draft: true,
        prerelease: true,
        target_commitish: "wrong",
        body:
          "<!-- doc-agent: source-id=openclaw-cloud-plugin -->\n" +
          "<!-- doc-agent: source-id=test-openclaw-cloud-plugin -->",
      }),
    ]],
    tag: "v0.1.20",
    expectedDraft: false,
    expectedPrerelease: false,
    expectedTargetCommitish: "abc123",
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.length, 4);
  assert.ok(invalid.errors.some((error) => /draft=true/.test(error)));
  assert.ok(invalid.errors.some((error) => /prerelease=true/.test(error)));
  assert.ok(invalid.errors.some((error) => /targets wrong/.test(error)));
  assert.ok(invalid.errors.some((error) => /exactly one Doc Agent source id/.test(error)));
});

test("accepts an already published matching release as an idempotent automatic Draft rerun", () => {
  const report = inspectReleaseInventory({
    pages: [[release({ draft: false })]],
    tag: "v0.1.20",
    expectedDraft: true,
    expectedPrerelease: false,
    expectedTargetCommitish: "abc123",
    allowPublishedForDraftRerun: true,
  });
  assert.equal(report.ok, true);
  assert.equal(report.state, "existing");
});

test("release workflow publishes committed main versions and pins recovery to npm gitHead", () => {
  const workflow = readFileSync(
    new URL("../workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /npm_release_git_head\(\)/);
  assert.match(
    workflow,
    /RELEASE_EVIDENCE_REF: \$\{\{ steps\.release_source\.outputs\.evidence_ref \}\}/,
  );
  assert.match(
    workflow,
    /release evidence is pinned to npm gitHead/,
  );
  assert.match(
    workflow,
    /missing GitHub metadata will target npm gitHead \$\{release_commit_sha\}/,
  );
  assert.match(
    workflow,
    /git tag -a "\$\{release_tag\}" "\$\{RELEASE_COMMIT_SHA\}"/,
  );
  assert.match(workflow, /Validate committed release source version/);
  assert.match(workflow, /validate-release-source-version\.mjs/);
  assert.match(
    workflow,
    /Publishing the already-reviewed \$\{DEFAULT_BRANCH\} commit \$\{release_commit_sha\}/,
  );
  assert.match(workflow, /is no longer the head of \$\{DEFAULT_BRANCH\}/);
  assert.match(
    workflow,
    /Normal real releases require git_ref to be the exact 40-character source_commit approved in the dry-run/,
  );
  assert.match(
    workflow,
    /Recovery requires \$\{PACKAGE_NAME\}@\$\{RELEASE_VERSION\} to already exist on npm/,
  );
  assert.match(workflow, /release-source\.json/);
  assert.match(
    workflow,
    /EXPECTED_RELEASE_PRERELEASE: \$\{\{ steps\.release_policy\.outputs\.github_release_prerelease \}\}/,
  );
  assert.match(workflow, /release_flags\+=\(--prerelease\)/);
  assert.ok(
    workflow.indexOf("Validate committed release source version") <
      workflow.indexOf('npm publish --access public --tag "${NPM_DIST_TAG}"'),
    "the committed source version gate must run before npm publish",
  );
  assert.match(
    workflow,
    /--target "\$\{RELEASE_COMMIT_SHA\}"/,
  );
  assert.match(workflow, /gh api --paginate --slurp/);
  assert.match(workflow, /wait-for-npm-release\.mjs/);
  assert.match(workflow, /NPM_VISIBILITY_TIMEOUT_SECONDS: "150"/);
  assert.match(workflow, /NPM_VISIBILITY_INTERVAL_SECONDS: "10"/);
  assert.match(
    workflow,
    /version, gitHead, and dist-tag were not all visible within \$\{NPM_VISIBILITY_TIMEOUT_SECONDS\}s/,
  );
  assert.match(workflow, /GITHUB_RELEASE_VISIBILITY_ATTEMPTS: "12"/);
  assert.match(workflow, /GITHUB_RELEASE_VISIBILITY_INTERVAL_SECONDS: "10"/);
  assert.match(workflow, /EXPECTED_RELEASE_DRAFT="\$\{CREATE_DRAFT_RELEASE\}"/);
  assert.match(workflow, /ALLOW_PUBLISHED_FOR_DRAFT_RERUN="\$\{CREATE_DRAFT_RELEASE\}"/);
  assert.match(
    workflow,
    /Refusing to issue a second create request/,
  );
  assert.match(
    workflow,
    /Verified resume mode enabled; npm version exists, so publish is skipped/,
  );
  assert.match(
    workflow,
    /this automatic release is locked to merged commit \$\{AUTOMATIC_RELEASE_TARGET\}/,
  );
  assert.match(workflow, /report_exhausted_failure "github-release-create"/);
  assert.match(workflow, /report_exhausted_failure "github-release-verification"/);
  assert.match(workflow, /report_exhausted_failure "github-release-tag-push"/);
  assert.doesNotMatch(
    workflow,
    /npm version "\$\{RELEASE_VERSION\}".*--no-git-tag-version/,
  );
  assert.doesNotMatch(workflow, /npm run sync-version/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /gh pr create/);
  assert.doesNotMatch(workflow, /release_branch/);
  assert.doesNotMatch(workflow, /create_version_pr/);
  assert.doesNotMatch(workflow, /gh release view/);
  assert.match(
    workflow,
    /CREATE_DRAFT_RELEASE: \$\{\{ github\.event_name == 'pull_request' \|\| inputs\.recover_existing_npm_release == true \}\}/,
  );
});

test("real publishes are version-transition-gated and reusable callers are immutable dry runs", () => {
  const releaseWorkflow = readFileSync(
    new URL("../workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    releaseWorkflow,
    /Real releases must be dispatched from the protected default branch/,
  );
  assert.match(releaseWorkflow, /pull_request:\s*\n\s*types: \[closed\]/);
  assert.match(releaseWorkflow, /resolve-auto-release\.mjs/);
  assert.match(releaseWorkflow, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(releaseWorkflow, /\^release\/v/);
  assert.match(releaseWorkflow, /--draft/);
  assert.match(
    releaseWorkflow,
    /npm \$\{RELEASE_VERSION\} and tag \$\{release_tag\} were verified before the Draft was created/,
  );
  assert.ok(
    releaseWorkflow.indexOf('npm publish --access public --tag "${NPM_DIST_TAG}"') <
      releaseWorkflow.indexOf("release_flags+=(--draft)"),
    "npm must be published and verified before the human-reviewed Draft is created",
  );

  for (const name of [
    "pre-merge-dry-run.yml",
    "post-merge-dry-run.yml",
    "historical-dry-run.yml",
  ]) {
    const workflow = readFileSync(
      new URL(`../workflows/${name}`, import.meta.url),
      "utf8",
    );
    assert.match(workflow, /dry_run: true/);
    assert.doesNotMatch(workflow, /dry_run: false/);
    if (name !== "historical-dry-run.yml") {
      assert.match(workflow, /wait-for-npm-release\.mjs/);
      assert.match(workflow, /wait-for-npm-release\.test\.mjs/);
    }
  }

  const contractLintWorkflow = readFileSync(
    new URL("../workflows/workflow-contract-lint.yml", import.meta.url),
    "utf8",
  );
  const preMergeWorkflow = readFileSync(
    new URL("../workflows/pre-merge-dry-run.yml", import.meta.url),
    "utf8",
  );
  assert.match(preMergeWorkflow, /- "fix\/\*\*"/);
  assert.match(contractLintWorkflow, /- "fix\/\*\*"/);
  assert.match(preMergeWorkflow, /pull_request:/);
  assert.match(preMergeWorkflow, /Validate proposed four-file version transition/);
  assert.match(preMergeWorkflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(contractLintWorkflow, /- "release\/v\*\*"/);
  assert.doesNotMatch(preMergeWorkflow, /- "release\/v\*\*"/);
  assert.match(contractLintWorkflow, /resolve-auto-release\.test\.mjs/);
  assert.match(contractLintWorkflow, /wait-for-npm-release\.test\.mjs/);
  assert.match(releaseWorkflow, /^permissions:\s*\n\s*contents: read/m);
  assert.match(releaseWorkflow, /publish:\s*\n[\s\S]*?permissions:\s*\n\s*contents: write/);
});

test("dry-run callers use least privilege and do not inherit all repository secrets", () => {
  const releaseWorkflow = readFileSync(
    new URL("../workflows/release.yml", import.meta.url),
    "utf8",
  );
  const dryRunWorkflow = readFileSync(
    new URL("../workflows/release-dry-run.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(releaseWorkflow, /workflow_call:/);
  assert.match(releaseWorkflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(
    releaseWorkflow,
    /persist-credentials: \$\{\{ github\.event_name == 'pull_request' \|\| inputs\.dry_run != true \}\}/,
  );
  assert.match(dryRunWorkflow, /workflow_call:/);
  assert.match(dryRunWorkflow, /permissions:\s*\n\s*contents: read/);
  assert.match(dryRunWorkflow, /persist-credentials: false/);
  assert.doesNotMatch(dryRunWorkflow, /NPM_TOKEN/);
  assert.doesNotMatch(dryRunWorkflow, /npm publish/);
  assert.doesNotMatch(dryRunWorkflow, /gh release/);
  assert.doesNotMatch(dryRunWorkflow, /contents: write/);
  assert.doesNotMatch(dryRunWorkflow, /pull-requests: write/);

  const preMerge = readFileSync(
    new URL("../workflows/pre-merge-dry-run.yml", import.meta.url),
    "utf8",
  );
  assert.match(preMerge, /permissions:\s*\n\s*contents: read/);
  assert.match(preMerge, /uses: \.\/\.github\/workflows\/release-dry-run\.yml/);
  assert.match(preMerge, /release_notes: \|/);
  assert.match(preMerge, /doc-agent-release-notes-json/);
  assert.doesNotMatch(preMerge, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(preMerge, /secrets: inherit/);
  assert.doesNotMatch(preMerge, /contents: write/);
  assert.doesNotMatch(preMerge, /pull-requests: write/);

  for (const name of [
    "post-merge-dry-run.yml",
    "historical-dry-run.yml",
  ]) {
    const workflow = readFileSync(
      new URL(`../workflows/${name}`, import.meta.url),
      "utf8",
    );
    assert.match(workflow, /permissions:\s*\n(?:\s*#[^\n]*\n)*\s*contents: read/);
    assert.match(workflow, /uses: \.\/\.github\/workflows\/release-dry-run\.yml/);
    assert.doesNotMatch(workflow, /secrets: inherit/);
    assert.doesNotMatch(workflow, /NPM_TOKEN/);
    assert.doesNotMatch(workflow, /contents: write/);
    assert.doesNotMatch(workflow, /pull-requests: write/);
  }

  const postMerge = readFileSync(
    new URL("../workflows/post-merge-dry-run.yml", import.meta.url),
    "utf8",
  );
  assert.match(postMerge, /version: \$\{\{ needs\.release_source\.outputs\.version \}\}/);
  assert.match(
    postMerge,
    /expected_current_ref: \$\{\{ needs\.release_source\.outputs\.source_sha \}\}/,
  );
  assert.match(postMerge, /enforce_source_version: true/);
  assert.doesNotMatch(postMerge, /version: "0\.1\.19"/);

  const preMergeDryRun = readFileSync(
    new URL("../workflows/pre-merge-dry-run.yml", import.meta.url),
    "utf8",
  );
  assert.match(preMergeDryRun, /enforce_source_version: false/);

  const historical = readFileSync(
    new URL("../workflows/historical-dry-run.yml", import.meta.url),
    "utf8",
  );
  assert.match(historical, /enforce_source_version: false/);
  assert.match(historical, /github\.event\.repository\.default_branch/);
  for (const [version, previousTag] of [
    ["0.1.15", "v0.1.14"],
    ["0.1.16", "v0.1.15"],
    ["0.1.17", "v0.1.16"],
    ["0.1.18", "v0.1.17"],
    ["0.1.19", "v0.1.18"],
  ]) {
    assert.match(
      historical,
      new RegExp(
        `version: "${version.replaceAll(".", "\\.")}"\\s+expected_previous_tag: "${previousTag.replaceAll(".", "\\.")}"\\s+expected_current_ref: "v${version.replaceAll(".", "\\.")}"`,
      ),
    );
  }

  const contractLint = readFileSync(
    new URL("../workflows/workflow-contract-lint.yml", import.meta.url),
    "utf8",
  );
  assert.match(contractLint, /permissions:\s*\n\s*contents: read/);
  assert.match(contractLint, /persist-credentials: false/);
  assert.match(contractLint, /ACTIONLINT_VERSION: "1\.7\.12"/);
  assert.match(
    contractLint,
    /ACTIONLINT_LINUX_AMD64_SHA256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"/,
  );
  assert.match(
    contractLint,
    /node --test \.github\/scripts\/resolve-auto-release\.test\.mjs \.github\/scripts\/validate-github-release-inventory\.test\.mjs \.github\/scripts\/validate-release-confirmation\.test\.mjs \.github\/scripts\/validate-release-source-version\.test\.mjs/,
  );
  assert.doesNotMatch(contractLint, /secrets:/);
  assert.doesNotMatch(contractLint, /contents: write/);
  assert.doesNotMatch(contractLint, /pull-requests: write/);
  assert.doesNotMatch(contractLint, /uses: \.\/\.github\/workflows\/release/);
});
