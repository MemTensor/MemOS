import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PRODUCT_ID,
  RELEASE_NOTE_METHODS,
  assertMemOSVersionAtRef,
  buildDocsPreview,
  collectLocalPluginEvidence,
  compareSemver,
  cleanLocalPluginVersion,
  cleanVersion,
  docsPreviewMarkdown,
  existingReleaseTagState,
  fallbackTopicForText,
  findPreviousStableLocalPluginTag,
  findPreviousMemOSTag,
  generateGitHubReleaseNotes,
  incrementPatchVersion,
  localPluginTagForVersion,
  npmVersionLookupResult,
  requestDocAgentDraft,
  sourceRefsFromText,
  validateDraft,
  validateLocalPluginVersionPlan,
  validatePublishConfirmation,
  validateReleaseTarget,
} from "./prepare-memos-release.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptsDir = __dirname;
const workflowsDir = join(__dirname, "../workflows");

const evidence = {
  repo: "MemTensor/MemOS",
  previous_tag: "v2.0.24",
  current_tag: "v2.0.25",
  memos_previous_tag: "v2.0.24",
  memos_current_tag: "v2.0.25",
  local_plugin_previous_tag: "memos-local-plugin-v2.0.10",
  git_ref: "0123456789abcdef0123456789abcdef01234567",
  local_plugin_previous_version: "v2.0.10",
  local_plugin_previous_version_raw: "2.0.10",
  local_plugin_version: "v2.0.11",
  local_plugin_version_raw: "2.0.11",
  local_plugin_version_changed: true,
  local_plugin_version_source: "apps/memos-local-plugin/package.json",
  local_plugin_version_auto_incremented: false,
  local_plugin_package_previous_version: "v2.0.10",
  local_plugin_package_previous_version_raw: "2.0.10",
  local_plugin_package_version: "v2.0.11",
  local_plugin_package_version_raw: "2.0.11",
  local_plugin_package_version_changed: true,
  local_plugin_release_requested: true,
  pending_local_plugin_changes: false,
  product_paths: ["apps/memos-local-plugin/**"],
  has_product_changes: true,
  has_user_facing_product_changes: true,
  commits: [
    {
      sha: "9deb941e00000000000000000000000000000000",
      short_sha: "9deb941e",
      subject: "feat(l3): dedicated l3Llm config slot for abstraction pass (#1959)",
    },
    {
      sha: "59c1474600000000000000000000000000000000",
      short_sha: "59c14746",
      subject: "Fix #2076: local-plugin gateway CPU 100% - synchronous full-table vector scan (#2077)",
    },
  ],
  important_commits: [
    {
      sha: "9deb941e00000000000000000000000000000000",
      short_sha: "9deb941e",
      subject: "feat(l3): dedicated l3Llm config slot for abstraction pass (#1959)",
    },
    {
      sha: "59c1474600000000000000000000000000000000",
      short_sha: "59c14746",
      subject: "Fix #2076: local-plugin gateway CPU 100% - synchronous full-table vector scan (#2077)",
    },
  ],
  required_source_refs: [
    {
      short_sha: "9deb941e",
      accepted_refs: ["9deb941e", "9deb941e00000000000000000000000000000000", "#1959"],
    },
    {
      short_sha: "59c14746",
      accepted_refs: ["59c14746", "59c1474600000000000000000000000000000000", "#2076", "#2077"],
    },
  ],
  pull_requests: [{ number: "1959" }, { number: "2076" }, { number: "2077" }],
};

const validDraft = {
  ok: true,
  needs_review: false,
  release_items: [
    {
      category: "Added",
      text_cn: "**L3 抽象模型配置**：新增专用 L3 LLM 配置入口，便于独立管理抽象结论阶段的模型调用。",
      text_en: "**L3 abstraction model configuration**: Added a dedicated L3 LLM configuration entry for the abstraction pass.",
      source_refs: ["9deb941e"],
    },
    {
      category: "Improved",
      text_cn: "**向量扫描性能优化**：优化本地插件网关的大批量向量扫描流程，降低同步全表扫描造成的 CPU 压力。",
      text_en: "**Vector scan performance**: Optimized large local-plugin vector scans to reduce CPU pressure from synchronous full-table reads.",
      source_refs: ["59c14746", "#2077"],
    },
  ],
};

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeRepoFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function commitAll(message) {
  git(["add", "."]);
  git(["commit", "-q", "-m", message]);
}

function withFixtureRepo(fn) {
  const originalCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "memos-release-evidence-"));
  try {
    process.chdir(root);
    git(["init", "-q"]);
    git(["config", "user.email", "release-test@example.invalid"]);
    git(["config", "user.name", "Release Test"]);
    writeRepoFile(
      "apps/memos-local-plugin/package.json",
      `${JSON.stringify({ name: "@memtensor/memos-local-plugin", version: "9.9.0" }, null, 2)}\n`,
    );
    writeRepoFile("apps/memos-local-plugin/src/index.js", "export const baseline = true;\n");
    writeRepoFile("memos/core/session.js", "export const sessionCore = true;\n");
    writeRepoFile("packages/memos-sdk/index.js", "export const sdk = true;\n");
    commitAll("chore: baseline release");
    git(["tag", "v9.9.0"]);
    return fn(root);
  } finally {
    process.chdir(originalCwd);
  }
}

test("compares prerelease versions with SemVer precedence", () => {
  assert.ok(compareSemver("1.0.0-beta.10", "1.0.0-beta.9") > 0);
  assert.ok(compareSemver("1.0.0-beta.20", "1.0.0-beta.19") > 0);
  assert.ok(compareSemver("1.0.0", "1.0.0-beta.20") > 0);
  assert.equal(compareSemver("1.0.0+build.2", "1.0.0+build.1"), 0);
});

test("selects the previous MemOS stable tag for release evidence", () => {
  assert.equal(
    findPreviousMemOSTag("2.0.25", "v2.0.25", ["v2.0.24", "v2.0.25", "v2.0.25-beta.1", "memos-local-plugin-v2.0.10"]),
    "v2.0.24",
  );
  assert.equal(
    findPreviousMemOSTag("2.0.26-beta.2", "v2.0.26-beta.2", ["v2.0.25", "v2.0.26-beta.1", "v2.0.24"]),
    "v2.0.26-beta.1",
  );
});

test("extracts PR refs from GitHub release note wording", () => {
  assert.deepEqual(
    sourceRefsFromText(
      "feat: add provider routing by @someone in #1958\nFix #2131: dashboard drift (#2132)\nhttps://github.com/MemTensor/MemOS/pull/2146",
    ),
    ["#1958", "#2131", "#2132", "#2146"],
  );
});

test("rejects leading v in manual version input", () => {
  assert.equal(cleanVersion("2.0.25"), "2.0.25");
  assert.throws(() => cleanVersion("v2.0.25"), /must not include a leading v/);
  assert.equal(cleanLocalPluginVersion("2.0.12"), "2.0.12");
  assert.throws(() => cleanLocalPluginVersion(""), /is required/);
  assert.throws(() => cleanLocalPluginVersion("v2.0.12"), /must not include a leading v/);
  assert.throws(() => cleanLocalPluginVersion("2.0.12+build.1"), /must not contain SemVer build metadata/);
  assert.equal(incrementPatchVersion("2.0.12"), "2.0.13");
  assert.throws(() => incrementPatchVersion("2.0.12-beta.1"), /Cannot auto-increment prerelease/);
});

test("leaves local-plugin publishing disabled when local_plugin_version is blank", () => {
  const plan = validateLocalPluginVersionPlan(evidence, "");
  assert.equal(plan.release_requested, false);
  assert.equal(plan.pending_local_plugin_changes, true);
  assert.equal(plan.version, "v2.0.10");
  assert.equal(plan.next_patch_version, "v2.0.11");
  assert.equal(plan.local_plugin_tag, "");
  assert.match(plan.input_ignored_reason, /left blank/);
});

test("accepts only the next unused stable patch for a weekly local-plugin release", () => {
  const plan = validateLocalPluginVersionPlan(evidence, "2.0.11");
  assert.equal(plan.release_requested, true);
  assert.equal(plan.input_raw, "2.0.11");
  assert.equal(plan.expected_version, "v2.0.11");
  assert.equal(plan.pending_local_plugin_changes, false);
  assert.equal(plan.version, "v2.0.11");
  assert.equal(plan.version_source, "manual_weekly_release_opt_in");
  assert.equal(plan.local_plugin_tag, "memos-local-plugin-v2.0.11");
  assert.equal(plan.package_version, "v2.0.11");
  assert.throws(() => validateLocalPluginVersionPlan(evidence, "2.0.12"), /next stable patch/);
  assert.throws(() => validateLocalPluginVersionPlan(evidence, "3.0.0"), /next stable patch/);
  assert.throws(() => validateLocalPluginVersionPlan(evidence, "2.0.11-beta.1"), /stable SemVer/);
});

test("fails when a weekly local-plugin version is supplied without publishable evidence", () => {
  assert.throws(
    () => validateLocalPluginVersionPlan({ ...evidence, has_product_changes: false, has_user_facing_product_changes: false }, "2.0.11"),
    /no unpublished apps\/memos-local-plugin/,
  );
  assert.throws(
    () => validateLocalPluginVersionPlan({ ...evidence, has_user_facing_product_changes: false }, "2.0.11"),
    /no unpublished user-facing/,
  );
  const skipped = validateLocalPluginVersionPlan(
    { ...evidence, has_product_changes: false, has_user_facing_product_changes: false },
    "",
  );
  assert.equal(skipped.release_requested, false);
  assert.equal(skipped.pending_local_plugin_changes, false);
});

test("used npm/tag versions fail closed unless npm-backed recovery is explicit", () => {
  assert.throws(
    () => validateLocalPluginVersionPlan(evidence, "2.0.11", { requestedTagExists: true }),
    /already used by git tag/,
  );
  assert.throws(
    () => validateLocalPluginVersionPlan(evidence, "2.0.11", { npmVersionExists: true }),
    /already used by npm/,
  );
  assert.throws(
    () => validateLocalPluginVersionPlan(evidence, "2.0.11", {
      requestedTagExists: true,
      npmVersionExists: false,
      recoveryEnabled: true,
    }),
    /requires the existing npm version/,
  );
  assert.throws(
    () => validateLocalPluginVersionPlan(evidence, "2.0.11", {
      requestedTagExists: false,
      npmVersionExists: false,
      recoveryEnabled: true,
    }),
    /requires the existing npm version/,
  );
  const recoveredAfterNpmOnlyFailure = validateLocalPluginVersionPlan(evidence, "2.0.11", {
    requestedTagExists: false,
    npmVersionExists: true,
    recoveryEnabled: true,
  });
  assert.equal(recoveredAfterNpmOnlyFailure.recovery_enabled, true);
  assert.equal(recoveredAfterNpmOnlyFailure.requested_tag_exists, false);
  assert.equal(recoveredAfterNpmOnlyFailure.npm_version_exists, true);
  const recovered = validateLocalPluginVersionPlan(evidence, "2.0.11", {
    requestedTagExists: true,
    npmVersionExists: true,
    recoveryEnabled: true,
  });
  assert.equal(recovered.recovery_enabled, true);
  assert.equal(recovered.release_requested, true);
});

test("resolves stable local-plugin tag baselines independently from MemOS tags", () => {
  const tags = [
    "v2.0.27",
    "memos-local-plugin-v2.0.10",
    "memos-local-plugin-v2.0.12-beta.1",
    "memos-local-plugin-v2.0.11",
  ];
  const previous = findPreviousStableLocalPluginTag(tags);
  assert.equal(previous.tag, "memos-local-plugin-v2.0.11");
  assert.equal(previous.version, "2.0.11");
  assert.equal(localPluginTagForVersion("2.0.12"), "memos-local-plugin-v2.0.12");
  assert.equal(npmVersionLookupResult({ status: 0, output: '"2.0.12"' }), true);
  assert.equal(npmVersionLookupResult({ status: 1, output: "E404 Not Found" }), false);
  assert.throws(
    () => npmVersionLookupResult({ status: 1, output: "ECONNRESET" }),
    /npm version lookup was inconclusive: ECONNRESET/,
  );
});

test("requires an exact publish confirmation for non-dry-run releases", () => {
  assert.doesNotThrow(() => validatePublishConfirmation({ dryRun: "true", version: "2.0.25", confirmation: "" }));
  assert.throws(
    () => validatePublishConfirmation({ dryRun: "false", version: "2.0.25", confirmation: "" }),
    /PUBLISH v2\.0\.25/,
  );
  assert.doesNotThrow(() =>
    validatePublishConfirmation({ dryRun: "false", version: "2.0.25", confirmation: "PUBLISH v2.0.25" }),
  );
  assert.throws(
    () => validatePublishConfirmation({
      dryRun: "false",
      version: "2.0.25",
      localPluginVersion: "2.0.11",
      confirmation: "PUBLISH v2.0.25",
    }),
    /WITH LOCAL PLUGIN v2\.0\.11/,
  );
  assert.doesNotThrow(() => validatePublishConfirmation({
    dryRun: "false",
    version: "2.0.25",
    localPluginVersion: "2.0.11",
    confirmation: "PUBLISH v2.0.25 WITH LOCAL PLUGIN v2.0.11",
  }));
});

test("publish workflow defaults real releases to draft before release.published", () => {
  const workflow = readFileSync(join(workflowsDir, "memos-release-publish-main.yml"), "utf8");
  assert.match(workflow, /create_draft_release:/);
  assert.match(workflow, /default:\s+true/);
  assert.match(workflow, /CREATE_DRAFT_RELEASE/);
  assert.match(workflow, /timeout-minutes:\s+30/);
  assert.match(workflow, /Validate publish confirmation/);
  assert.match(workflow, /publish_confirmation must exactly equal/);
  assert.match(workflow, /flags\+=\(--draft\)/);
  assert.match(workflow, /wait_for_remote_tag\(\)/);
  assert.match(workflow, /wait_for_release_visibility\(\)/);
  assert.match(workflow, /create_release_if_missing\(\)/);
  assert.match(workflow, /--json body,isDraft,tagName,targetCommitish,url/);
  assert.match(workflow, /target_commitish/);
  assert.match(workflow, /already exists with different notes or local-plugin intent/);
  assert.match(workflow, /GitHub Release \$\{CURRENT_TAG\} targets \$\{target_commitish\}, expected \$\{TARGET_SHA\}/);
  assert.match(workflow, /exists after a failed create response; treating it as success/);
  assert.match(workflow, /did not become visible in time/);
  assert.match(workflow, /local-plugin Release is always staged as a Draft/);
  assert.match(workflow, /local_plugin_version:/);
  assert.match(workflow, /Leave blank to skip local-plugin npm\/tag\/docs/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/memos-local-plugin-publish\.yml/);
  assert.match(workflow, /docs_sync_mode: paired_with_memos_release/);
  assert.match(workflow, /memos_release_tag: v\$\{\{ inputs\.version \}\}/);
  assert.match(workflow, /create_draft_release: true/);
  assert.doesNotMatch(workflow, /create_draft_release: \$\{\{ inputs\.create_draft_release \}\}/);
  assert.match(workflow, /needs\.prepare\.outputs\.local_plugin_release_requested == 'true'/);
  assert.match(workflow, /permissions:\n\s+contents: write\n\s+uses: \.\/\.github\/workflows\/memos-local-plugin-publish\.yml/);
  assert.match(
    workflow,
    /local_plugin_expected_version: \$\{\{ steps\.prepare\.outputs\.local_plugin_expected_version \}\}/,
  );
  assert.match(
    workflow,
    /local_plugin_publish_version: \$\{\{ steps\.prepare\.outputs\.local_plugin_publish_version \}\}/,
  );
  assert.match(workflow, /version: \$\{\{ needs\.prepare\.outputs\.local_plugin_publish_version \}\}/);
  assert.match(
    workflow,
    /LOCAL_PLUGIN_VERSION: \$\{\{ needs\.prepare\.outputs\.local_plugin_publish_version \}\}/,
  );
  assert.doesNotMatch(workflow, /version: \$\{\{ needs\.prepare\.outputs\.local_plugin_version \}\}/);
  assert.doesNotMatch(workflow, /version: \$\{\{ needs\.prepare\.outputs\.local_plugin_expected_version \}\}/);
  assert.match(workflow, /needs\.publish-local-plugin\.result == 'success'/);
  assert.match(workflow, /needs\.publish-local-plugin\.result == 'skipped'/);
  assert.match(workflow, /append-local-plugin-release-intent\.mjs/);
  assert.match(workflow, /LOCAL_PLUGIN_RELEASE_URL/);
  assert.match(workflow, /local_plugin_evidence_digest/);
  assert.match(workflow, /WITH LOCAL PLUGIN v\$\{LOCAL_PLUGIN_VERSION\}/);
  assert.match(workflow, /Publish paired local-plugin Release after immediate MemOS publish/);
  assert.match(workflow, /id: memos_release/);
  assert.match(workflow, /release_is_draft=\$\{is_draft\}/);
  assert.match(workflow, /steps\.memos_release\.outputs\.release_is_draft == 'false'/);
  assert.match(workflow, /MEMOS_RELEASE_TAG_OVERRIDE: \$\{\{ needs\.prepare\.outputs\.current_tag \}\}/);
  assert.match(workflow, /run: node \.github\/scripts\/publish-paired-local-plugin-release\.mjs/);
});

test("paired local-plugin publisher is release-triggered, idempotent, and has explicit recovery", () => {
  const workflow = readFileSync(
    join(workflowsDir, "memos-release-publish-paired-local-plugin.yml"),
    "utf8",
  );
  assert.match(workflow, /release:\n\s+types: \[published\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /PUBLISH PAIRED LOCAL PLUGIN FOR/);
  assert.match(workflow, /github\.repository == 'MemTensor\/MemOS'/);
  assert.match(workflow, /startsWith\(github\.event\.release\.tag_name, 'v'\)/);
  assert.match(workflow, /permissions:\n\s+contents: write/);
  assert.match(workflow, /publish-paired-local-plugin-release\.mjs/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|DOC_AGENT_RELEASE_SYNC|pull-requests:\s*write/);
});

test("legacy standalone local-plugin publisher requires an extra non-dry-run confirmation", () => {
  const workflow = readFileSync(join(workflowsDir, "memos-local-plugin-publish.yml"), "utf8");
  assert.match(workflow, /legacy_publish_confirmation:/);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /legacy_publish_confirmation:\n\s+description:.*\n\s+required: false\n\s+type: string/s);
  assert.match(workflow, /guard-legacy-publish:/);
  assert.match(workflow, /guard-legacy-publish:\n\s+runs-on: ubuntu-latest\n\s+timeout-minutes: 5/);
  assert.match(workflow, /expected="LEGACY PUBLISH memos-local-plugin-v\$\{RELEASE_VERSION\}"/);
  assert.match(workflow, /standalone local-plugin npm publisher for beta or latest package releases/);
  assert.match(workflow, /MemOS Release — Publish remains the weekly whole-repo release path/);
  assert.match(workflow, /needs: guard-legacy-publish/);
  assert.match(workflow, /Git ref to build package code from/);
  assert.match(workflow, /release automation always uses this workflow revision/);
  assert.match(workflow, /SemVer build metadata is not supported for npm\/tag publishing/);
  assert.equal((workflow.match(/Checkout trusted release automation scripts/g) || []).length, 2);
  assert.equal((workflow.match(/Use trusted release automation scripts/g) || []).length, 2);
  assert.match(workflow, /ref:\s+\$\{\{ github\.workflow_sha \}\}/);
  assert.match(workflow, /package_source_sha:/);
  assert.match(workflow, /needs\.guard-legacy-publish\.outputs\.package_source_sha/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /Formal publish source .* is not in .* history/);
  assert.match(workflow, /Formal publishing must use the latest release automation from/);
  assert.match(workflow, /Select \$\{DEFAULT_BRANCH\} in Run workflow and retry/);
  assert.match(workflow, /Validate npm authentication before platform builds/);
  assert.match(workflow, /if: \$\{\{ inputs\.dry_run != true \}\}/);
  assert.match(workflow, /npm whoami/);
  assert.match(workflow, /NPM_TOKEN authentication failed; stopping before platform builds/);
  assert.match(workflow, /cp -R \.release-workflow\/\.github\/scripts \.github\/scripts/);
  assert.match(workflow, /Package source ref: \$\(git rev-parse --short HEAD\)/);
  assert.match(workflow, /Release automation ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(workflow, /Inspect existing standalone package tag state/);
  assert.match(workflow, /inspect-local-plugin-release-state\.mjs/);
  assert.match(workflow, /EXPECTED_PACKAGE_SOURCE_SHA/);
  assert.match(workflow, /RELEASE_METADATA_STATE/);
  assert.match(workflow, /audit-local-plugin-package\.mjs/);
  assert.match(workflow, /wait-for-local-plugin-npm-release\.test\.mjs/);
  assert.match(workflow, /NPM_VISIBILITY_TIMEOUT_SECONDS: "150"/);
  assert.match(workflow, /FORCE_PACKAGE_ONLY_RELEASE: \$\{\{ inputs\.tag != 'latest' \|\| contains\(inputs\.version, '-'\) \}\}/);
  assert.match(workflow, /if \[ -n "\$\{DOCS_SYNC_MODE\}" \]; then/);
  assert.doesNotMatch(workflow, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(workflow, /paired_with_memos_release/);
  assert.match(workflow, /Create standalone package tag/);
  assert.match(workflow, /git commit -m "\$\{release_commit_message\}"/);
  assert.match(workflow, /git push origin "refs\/tags\/\$\{release_tag\}"/);
  assert.match(workflow, /DOC_AGENT_RELEASE_NOTES_DRAFT_URL/);
  assert.match(workflow, /Upload failed release notes diagnostics/);
  assert.match(workflow, /memos-local-plugin-release-notes-failure/);
  assert.match(workflow, /if-no-files-found: ignore/);
  assert.doesNotMatch(workflow, /prepare package inspection notes" -- node/);
  assert.doesNotMatch(workflow, /DOC_AGENT_RELEASE_SYNC_URL/);
  assert.doesNotMatch(workflow, /prepare-local-plugin-formal-sync\.mjs/);
  assert.doesNotMatch(workflow, /send-product-release-sync\.mjs/);
  assert.match(workflow, /inputs\.tag == 'latest' && !contains\(inputs\.version, '-'\)/);
  assert.match(workflow, /create-local-plugin-github-release\.mjs/);
  assert.match(workflow, /Create and verify independent local-plugin GitHub Release/);
  assert.match(workflow, /docs-preview\.md/);
  assert.match(workflow, /docs-preview\.json/);
  assert.match(workflow, /quality-report\.json/);
  assert.match(workflow, /skip_prerelease_docs/);
  assert.match(workflow, /independent GitHub Prerelease/);
  assert.match(workflow, /publish_paired_local_plugin_release/);
  assert.doesNotMatch(workflow, /pull-requests:\s*write/);
  assert.doesNotMatch(workflow, /gh pr (?:create|view)/);
  assert.doesNotMatch(workflow, /release_branch/);
  assert.doesNotMatch(workflow, /push release branch|refs\/heads\/release\//);
  assert.doesNotMatch(workflow, /cp "\$\{RELEASE_TARBALL\}" "\$\{inspection_dir\}\/"/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v7\.0\.1/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40} # v6\.4\.0/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40} # v7\.0\.1/);
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40} # v8\.0\.1/);

  const releaseNotesScript = readFileSync(
    join(scriptsDir, "draft-local-plugin-release-notes.mjs"),
    "utf8",
  );
  assert.match(releaseNotesScript, /candidate_count: 3/);
  assert.match(releaseNotesScript, /quality_issues/);
  assert.match(releaseNotesScript, /writeDraftFailureInspection/);
});

test("legacy standalone local-plugin post-merge dry run is not push-triggered", () => {
  const workflow = readFileSync(join(workflowsDir, "memos-local-plugin-post-merge-dry-run.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\npush:/);
  assert.doesNotMatch(workflow, /uses:\s+\.\/\.github\/workflows\/memos-local-plugin-publish\.yml/);
  assert.match(workflow, /This workflow no longer runs on push to main/);
  assert.match(workflow, /Use MemOS Release — Post-Merge Dry Run/);
});

test("read-only dry-run workflows declare bounded fallback behavior", () => {
  const workflows = [
    readFileSync(join(workflowsDir, "memos-release-pre-merge-dry-run.yml"), "utf8"),
    readFileSync(join(workflowsDir, "memos-release-post-merge-dry-run.yml"), "utf8"),
  ];
  for (const workflow of workflows) {
    assert.match(workflow, /concurrency:/);
    assert.match(workflow, /permissions:\n\s+contents: read/);
    assert.match(workflow, /timeout-minutes:\s+15/);
    assert.match(workflow, /ALLOW_OFFLINE_DOCS_PREVIEW: true/);
    assert.match(workflow, /offline_docs_preview: true/);
    assert.match(workflow, /production publish does not set ALLOW_OFFLINE_DOCS_PREVIEW/);
    assert.match(workflow, /TARGET_REF: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /\.github\/workflows\/memos-release-publish\.yml/);
    assert.doesNotMatch(workflow, /TARGET_REF: origin\/main|TARGET_REF: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  }
});

test("inspection artifact contract includes generic aliases and side-effect proof", () => {
  const script = readFileSync(join(scriptsDir, "prepare-memos-release.mjs"), "utf8");
  assert.match(script, /"release-notes\.md"/);
  assert.match(script, /"evidence\.json"/);
  assert.match(script, /"docs-preview\.md"/);
  assert.match(script, /"docs-preview\.json"/);
  assert.match(script, /source_id:\s+PRODUCT_ID/);
  assert.match(script, /release_kind:\s+"memos_whole_repo"/);
  assert.match(script, /docs_product_extraction:\s+"path_filtered"/);
  assert.match(script, /public_release_body:\s+"github_generated_whats_changed"/);
  assert.match(script, /existing_tag:\s+existingTag/);
  assert.match(script, /publish_blocked:\s+existingTag\.publish_blocked/);
  assert.match(script, /local_plugin_version_plan/);
  assert.match(script, /local_plugin_version_required/);
  assert.match(script, /no_side_effects:\s+\{/);
  assert.match(script, /npm_publish:\s+false/);
  assert.match(script, /production_docs_pr:\s+false/);
  assert.equal(PRODUCT_ID, "openclaw-local-plugin");
});

test("allows flexible target refs only for dry runs", () => {
  assert.doesNotThrow(() => validateReleaseTarget({ dryRun: "true", targetRef: "origin/main" }));
  assert.doesNotThrow(() => validateReleaseTarget({ dryRun: "false", targetRef: "main" }));
  assert.throws(() => validateReleaseTarget({ dryRun: "false", targetRef: "origin/main" }), /exactly main/);
  assert.throws(() => validateReleaseTarget({ dryRun: "false", targetRef: "feature/test" }), /exactly main/);
});

test("validates both MemOS package versions at the exact release target", () => {
  withFixtureRepo(() => {
    writeRepoFile("pyproject.toml", `[project]\nname = "MemoryOS"\nversion = "9.9.1"\n`);
    writeRepoFile("src/memos/__init__.py", `__version__ = "9.9.1"\n`);
    commitAll("chore: prepare package version");
    const target = git(["rev-parse", "HEAD"]).trim();

    assert.equal(assertMemOSVersionAtRef("9.9.1", target).version, "9.9.1");
    assert.throws(() => assertMemOSVersionAtRef("9.9.2", target), /expected 9\.9\.2/);

    writeRepoFile("src/memos/__init__.py", `__version__ = "9.9.0"\n`);
    commitAll("test: create mismatched package version");
    const mismatchedTarget = git(["rev-parse", "HEAD"]).trim();
    assert.throws(() => assertMemOSVersionAtRef("9.9.1", mismatchedTarget), /do not match/);
  });
});

test("reports absent, matching, and conflicting manual release tags", () => {
  withFixtureRepo(() => {
    const firstTarget = git(["rev-parse", "HEAD"]).trim();
    const absent = existingReleaseTagState("v9.9.1", firstTarget);
    assert.equal(absent.status, "absent");
    assert.equal(absent.publish_blocked, false);

    git(["tag", "v9.9.1", firstTarget]);
    const matching = existingReleaseTagState("v9.9.1", firstTarget);
    assert.equal(matching.status, "matches_target");
    assert.equal(matching.publish_blocked, false);
    assert.equal(matching.tag_sha, firstTarget);

    writeRepoFile("apps/memos-local-plugin/src/index.js", "export const newerTarget = true;\n");
    commitAll("fix(plugin): preserve release target after manual tag (#10)");
    const finalTarget = git(["rev-parse", "HEAD"]).trim();
    const conflicting = existingReleaseTagState("v9.9.1", finalTarget);
    assert.equal(conflicting.status, "conflicts_target");
    assert.equal(conflicting.publish_blocked, true);
    assert.equal(conflicting.tag_sha, firstTarget);
    assert.match(conflicting.message, /will not|Delete or recreate|points to/i);
  });
});

test("validates a bilingual source-referenced plugin docs draft", () => {
  const result = validateDraft(validDraft, evidence);
  assert.equal(result.ok, true);
  assert.equal(result.coverage.required_count, 2);
  assert.equal(result.coverage.covered_required_count, 2);
});

test("release note methodology records the sources used for quality policy", () => {
  assert.ok(RELEASE_NOTE_METHODS.some((item) => item.source === "github-auto-generated-release-notes"));
  assert.ok(RELEASE_NOTE_METHODS.some((item) => item.source === "keep-a-changelog"));
  assert.ok(RELEASE_NOTE_METHODS.some((item) => item.source === "conventional-commits"));
  assert.ok(RELEASE_NOTE_METHODS.some((item) => item.source === "release-please"));
  assert.ok(RELEASE_NOTE_METHODS.every((item) => item.url.startsWith("https://")));
});

test("collects no local-plugin evidence from non-plugin-only release noise", () => {
  withFixtureRepo(() => {
    writeRepoFile("memos/core/session.js", "export const sessionCore = 'telemetry-only';\n");
    commitAll("feat: add core session telemetry (#10)");

    const result = collectLocalPluginEvidence({
      previousTag: "v9.9.0",
      currentTag: "v9.9.1",
      currentRef: "HEAD",
      targetVersion: "9.9.1",
      repo: "MemTensor/MemOS",
    });

    assert.equal(result.has_product_changes, false);
    assert.deepEqual(result.changed_files, []);
    assert.deepEqual(result.commits, []);
    assert.deepEqual(result.important_commits, []);
    assert.deepEqual(result.required_source_refs, []);
    assert.deepEqual(result.product_paths, ["apps/memos-local-plugin/**"]);
  });
});

test("filters mixed MemOS release evidence down to local-plugin paths", () => {
  withFixtureRepo(() => {
    writeRepoFile("memos/core/session.js", "export const sessionCore = 'telemetry-only';\n");
    commitAll("feat: add core session telemetry (#10)");

    writeRepoFile("apps/memos-local-plugin/src/provider-routing.js", "export const providerRouting = true;\n");
    writeRepoFile("packages/memos-sdk/index.js", "export const sdk = 'noise in the same release range';\n");
    commitAll("feat(plugin): add provider config routing (#11)");

    const result = collectLocalPluginEvidence({
      previousTag: "v9.9.0",
      currentTag: "v9.9.1",
      currentRef: "HEAD",
      targetVersion: "9.9.1",
      repo: "MemTensor/MemOS",
    });

    assert.equal(result.has_product_changes, true);
    assert.deepEqual(
      result.changed_files.map((item) => item.path),
      ["apps/memos-local-plugin/src/provider-routing.js"],
    );
    assert.deepEqual(
      result.commits.map((commit) => commit.subject),
      ["feat(plugin): add provider config routing (#11)"],
    );
    assert.deepEqual(result.pull_requests.map((pr) => pr.number), ["11"]);
    assert.equal(result.required_source_refs.length, 1);
    assert.ok(result.required_source_refs[0].accepted_refs.includes("#11"));
    assert.ok(result.important_diff["apps/memos-local-plugin/**"][0].path.endsWith("provider-routing.js"));
    assert.equal(result.local_plugin_previous_version, "v9.9.0");
    assert.equal(result.local_plugin_version, "v9.9.0");
    assert.equal(result.local_plugin_version_changed, false);
  });
});

test("filters standalone local-plugin release metadata from docs evidence", () => {
  withFixtureRepo(() => {
    writeRepoFile("apps/memos-local-plugin/tests/e2e/v7-full-chain.e2e.test.ts", "export const v7Defaults = true;\n");
    commitAll("fix(plugin): preserve V7 session defaults (#11)");

    writeRepoFile(
      "apps/memos-local-plugin/package.json",
      `${JSON.stringify({ name: "@memtensor/memos-local-plugin", version: "9.9.1" }, null, 2)}\n`,
    );
    writeRepoFile("apps/memos-local-plugin/package-lock.json", "{\"lockfileVersion\": 3}\n");
    commitAll("release: @memtensor/memos-local-plugin v9.9.1 (#12)");
    writeRepoFile("apps/memos-local-plugin/package-lock.json", "{\"lockfileVersion\": 3, \"packages\": {}}\n");
    commitAll("Release/memos local plugin v9.9.1 beta.1 (#13)");

    const result = collectLocalPluginEvidence({
      previousTag: "v9.9.0",
      currentTag: "v9.9.1",
      currentRef: "HEAD",
      targetVersion: "9.9.1",
      repo: "MemTensor/MemOS",
    });

    assert.equal(result.has_product_changes, true);
    assert.equal(result.has_user_facing_product_changes, true);
    assert.deepEqual(
      result.commits.map((commit) => commit.subject),
      ["fix(plugin): preserve V7 session defaults (#11)"],
    );
    assert.deepEqual(
      result.important_commits.map((commit) => commit.subject),
      ["fix(plugin): preserve V7 session defaults (#11)"],
    );
    assert.deepEqual(result.pull_requests.map((pr) => pr.number), ["11"]);
    assert.deepEqual(result.required_source_refs.map((item) => item.accepted_refs.includes("#11")), [true]);
  });
});

test("keeps release merge aggregate items tied to local-plugin path refs", () => {
  withFixtureRepo(() => {
    writeRepoFile("apps/memos-local-plugin/server/routes/metrics.ts", "export const viewerMetrics = 'stable';\n");
    commitAll("fix: viewer dashboard drifts after namespace flip (#11)");

    writeRepoFile("memos/core/session.js", "export const sessionCore = 'memory-provider-noise';\n");
    commitAll("feat(memory): add workspace memory provider (#10)");

    writeRepoFile("apps/memos-local-plugin/server/routes/metrics.ts", "export const viewerMetrics = 'release merge';\n");
    git(["add", "."]);
    git([
      "commit",
      "-q",
      "-m",
      "release: merge dev-v9.9.1 into main (#99)",
      "-m",
      "* fix: viewer dashboard drifts after namespace flip (#11)",
      "-m",
      "* feat(memory): add workspace memory provider (#10)",
      "-m",
      "* feat: plugin marketplace card polish (#12)",
    ]);

    const result = collectLocalPluginEvidence({
      previousTag: "v9.9.0",
      currentTag: "v9.9.1",
      currentRef: "HEAD",
      targetVersion: "9.9.1",
      repo: "MemTensor/MemOS",
    });

    assert.deepEqual(
      result.release_aggregate_items.map((item) => item.text),
      ["fix: viewer dashboard drifts after namespace flip (#11)"],
    );
    assert.deepEqual(
      result.commits.map((commit) => commit.subject),
      ["fix: viewer dashboard drifts after namespace flip (#11)"],
    );
    assert.deepEqual(result.required_source_refs.map((item) => item.short_sha), ["#11"]);
  });
});

test("drops reverted release merge aggregate items from local-plugin evidence", () => {
  withFixtureRepo(() => {
    writeRepoFile("apps/memos-local-plugin/src/reflection.js", "export const scoring = 'batch';\n");
    commitAll("feat: chunk batch reflection scoring (#11)");
    const featureSha = git(["rev-parse", "HEAD"]).trim();

    writeRepoFile("apps/memos-local-plugin/src/reflection.js", "export const scoring = 'reverted';\n");
    git(["add", "."]);
    git([
      "commit",
      "-q",
      "-m",
      "Revert \"feat: chunk batch reflection scoring (#11)\" (#12)",
      "-m",
      `This reverts commit ${featureSha}.`,
    ]);

    writeRepoFile("apps/memos-local-plugin/server/routes/metrics.ts", "export const viewerMetrics = 'fixed';\n");
    commitAll("fix: viewer dashboard drifts after namespace flip (#13)");

    writeRepoFile("apps/memos-local-plugin/server/routes/metrics.ts", "export const viewerMetrics = 'release merge';\n");
    git(["add", "."]);
    git([
      "commit",
      "-q",
      "-m",
      "release: merge dev-v9.9.1 into main (#99)",
      "-m",
      "* feat: chunk batch reflection scoring (#11)",
      "-m",
      "* Revert \"feat: chunk batch reflection scoring (#11)\" (#12)",
      "-m",
      "* fix: viewer dashboard drifts after namespace flip (#13)",
    ]);

    const result = collectLocalPluginEvidence({
      previousTag: "v9.9.0",
      currentTag: "v9.9.1",
      currentRef: "HEAD",
      targetVersion: "9.9.1",
      repo: "MemTensor/MemOS",
    });

    assert.deepEqual(
      result.release_aggregate_items.map((item) => item.text),
      ["fix: viewer dashboard drifts after namespace flip (#13)"],
    );
    assert.deepEqual(
      result.commits.map((commit) => commit.subject),
      ["fix: viewer dashboard drifts after namespace flip (#13)"],
    );
    assert.deepEqual(result.pull_requests.map((pr) => pr.number), ["13"]);
    assert.ok(result.reverted_change_keys.includes("feat: chunk batch reflection scoring (#11)"));
  });
});

test("keeps a reapplied local-plugin change after an earlier commit was reverted", () => {
  withFixtureRepo(() => {
    writeRepoFile("apps/memos-local-plugin/src/reflection.js", "export const scoring = 'batch';\n");
    commitAll("feat: chunk batch reflection scoring");
    const featureSha = git(["rev-parse", "HEAD"]).trim();

    git(["revert", "--no-commit", featureSha]);
    git([
      "commit",
      "-q",
      "-m",
      "Revert \"feat: chunk batch reflection scoring\" (#12)",
      "-m",
      `This reverts commit ${featureSha}.`,
    ]);

    writeRepoFile("apps/memos-local-plugin/src/reflection.js", "export const scoring = 'reapplied';\n");
    commitAll("feat: chunk batch reflection scoring");
    const reappliedSha = git(["rev-parse", "--short", "HEAD"]).trim();

    const result = collectLocalPluginEvidence({
      previousTag: "v9.9.0",
      currentTag: "v9.9.1",
      currentRef: "HEAD",
      targetVersion: "9.9.1",
      repo: "MemTensor/MemOS",
    });

    assert.deepEqual(result.commits.map((commit) => commit.short_sha), [reappliedSha]);
    assert.deepEqual(result.important_commits.map((commit) => commit.short_sha), [reappliedSha]);
    assert.equal(result.has_user_facing_product_changes, true);
    assert.equal(result.skip_reason, "");
  });
});

test("fallback topic rewrites V7 session default fixes into user-facing docs copy", () => {
  const topic = fallbackTopicForText("fix(plugin): preserve V7 session defaults (#2158)", { allowGeneric: true });
  assert.equal(topic.category, "Fixed");
  assert.match(topic.text_cn, /V7 会话默认配置/);
  assert.match(topic.text_cn, /会话合并窗口/);
  assert.match(topic.text_en, /V7 session defaults/);
  assert.doesNotMatch(topic.text_cn, /fix\(plugin\)/);
});

test("fallback topic rewrites recall and host input work without raw commit prefixes", () => {
  const topic = fallbackTopicForText("fix(plugin): improve recall relevance and host input handling (#2196)", {
    allowGeneric: true,
  });
  assert.equal(topic.category, "Improved");
  assert.match(topic.text_cn, /召回相关性与宿主输入处理/);
  assert.match(topic.text_en, /Recall relevance and host input handling/);
  assert.doesNotMatch(topic.text_cn, /fix\(plugin\)/);
  assert.doesNotMatch(topic.text_en, /fix\(plugin\)/);
});

test("generic fallback strips Conventional Commit prefixes before validation", () => {
  const topic = fallbackTopicForText("fix(plugin): stabilize sandbox widget (#9999)", {
    allowGeneric: true,
  });
  assert.equal(topic.category, "Fixed");
  assert.match(topic.text_cn, /stabilize sandbox widget/);
  assert.doesNotMatch(topic.text_cn, /fix\(plugin\)/);
  assert.doesNotMatch(topic.text_en, /fix\(plugin\)/);
});

test("GitHub release notes fallback stays whole-repo when API access is unavailable", async () => {
  const originalCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "memos-release-notes-fallback-"));
  try {
    process.chdir(root);
    git(["init", "-q"]);
    git(["config", "user.email", "release-test@example.invalid"]);
    git(["config", "user.name", "Release Test"]);
    writeRepoFile("README.md", "baseline\n");
    commitAll("chore: baseline release");
    git(["tag", "v0.0.0"]);
    writeRepoFile("README.md", "baseline\nwhole repo feature\n");
    commitAll("feat: add fallback release note source (#123)");
    writeRepoFile("apps/memos-local-plugin/src/index.js", "export const fallback = true;\n");
    commitAll("fix(plugin): preserve fallback plugin change (#124)");
    const targetSha = git(["rev-parse", "HEAD"]).trim();

    const result = await generateGitHubReleaseNotes({
      repo: "MemTensor/MemOS",
      currentTag: "v0.0.1",
      targetSha,
      previousTag: "v0.0.0",
      token: "",
    });
    assert.equal(result.source, "local-fallback-after-github-error");
    assert.match(result.body, /## What's Changed/);
    assert.match(result.body, /feat: add fallback release note source/);
    assert.match(result.body, /fix\(plugin\): preserve fallback plugin change/);
    assert.match(result.body, /Full Changelog/);
    assert.doesNotMatch(result.body, /source_refs/);
    assert.doesNotMatch(result.body, /doc-agent-release-notes-json/);
  } finally {
    process.chdir(originalCwd);
  }
});

test("rejects English text that still contains Chinese", () => {
  const result = validateDraft(
    {
      ...validDraft,
      release_items: [{ ...validDraft.release_items[0], text_en: "Added L3 抽象 model configuration." }],
    },
    evidence,
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.kind === "invalid_text_en"));
});

test("rejects missing or invented source refs", () => {
  const missing = validateDraft(
    {
      ...validDraft,
      release_items: [{ ...validDraft.release_items[0], source_refs: [] }, validDraft.release_items[1]],
    },
    evidence,
  );
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((issue) => issue.kind === "missing_source_refs"));

  const invented = validateDraft(
    {
      ...validDraft,
      release_items: [{ ...validDraft.release_items[0], source_refs: ["deadbee"] }, validDraft.release_items[1]],
    },
    evidence,
  );
  assert.equal(invented.ok, false);
  assert.ok(invented.issues.some((issue) => issue.kind === "invalid_source_ref"));
});

test("rejects drafts that drop important commits", () => {
  const result = validateDraft({ ...validDraft, release_items: [validDraft.release_items[0]] }, evidence);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.kind === "missing_required_ref" && issue.ref === "59c14746"));
});

test("rejects plugin docs drafts that are too fragmented for the changelog page", () => {
  const noisyItems = Array.from({ length: 13 }, (_item, index) => ({
    category: "Improved",
    text_cn: `**本地插件优化 ${index + 1}**：整理发布说明展示效果。`,
    text_en: `**Local plugin improvement ${index + 1}**: Refined release-note presentation.`,
    source_refs: [index % 2 === 0 ? "9deb941e" : "59c14746"],
  }));
  const result = validateDraft({ ...validDraft, release_items: noisyItems }, evidence);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.kind === "too_many_release_items"));
});

test("rejects plugin docs bullets that are too long to render well", () => {
  const result = validateDraft(
    {
      ...validDraft,
      release_items: [
        {
          ...validDraft.release_items[0],
          text_cn: `**L3 抽象模型配置**：${"用于发布说明质量验证的重复中文描述。".repeat(12)}`,
          text_en: `**L3 abstraction model configuration**: ${"This repeated English detail is intentionally too verbose for a changelog bullet. ".repeat(6)}`,
        },
        validDraft.release_items[1],
      ],
    },
    evidence,
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.kind === "text_cn_too_long"));
  assert.ok(result.issues.some((issue) => issue.kind === "text_en_too_long"));
});

test("rejects generic Chinese plugin docs copy", () => {
  const result = validateDraft(
    {
      ...validDraft,
      release_items: [
        {
          ...validDraft.release_items[0],
          text_cn: "**本地插件能力**：新增了本地插件能力功能。",
        },
        validDraft.release_items[1],
      ],
    },
    evidence,
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.kind === "generic_text_cn"));
});

test("rejects generic English plugin docs copy", () => {
  const result = validateDraft(
    {
      ...validDraft,
      release_items: [
        {
          ...validDraft.release_items[0],
          text_en: "**Local plugin update**: Fixed local plugin issue.",
        },
        validDraft.release_items[1],
      ],
    },
    evidence,
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.kind === "generic_text_en"));
});

test("rejects raw Conventional Commit subjects copied into docs copy", () => {
  const result = validateDraft(
    {
      ...validDraft,
      release_items: [
        {
          ...validDraft.release_items[0],
          text_en: "**V7 defaults**: fix(plugin): preserve V7 session defaults (#2158).",
        },
        validDraft.release_items[1],
      ],
    },
    evidence,
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.kind === "raw_commit_subject_text" && issue.field === "text_en"));
});

test("rejects duplicate plugin docs bullets that should be merged", () => {
  const result = validateDraft(
    {
      ...validDraft,
      release_items: [
        validDraft.release_items[0],
        {
          ...validDraft.release_items[0],
          source_refs: ["59c14746"],
        },
      ],
    },
    evidence,
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.kind === "duplicate_release_item"));
});

test("accepts concise impact-oriented Chinese plugin docs copy", () => {
  const result = validateDraft(
    {
      ...validDraft,
      release_items: [
        validDraft.release_items[0],
        {
          ...validDraft.release_items[1],
          text_cn: "**向量扫描性能优化**：优化了自适应向量扫描批处理，提升了大数据量同步时的处理效率。",
        },
      ],
    },
    evidence,
  );
  assert.equal(result.ok, true);
});

test("allows the draft service one initial response plus three repair attempts", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL;
  const originalToken = process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN;
  const originalOffline = process.env.ALLOW_OFFLINE_DOCS_PREVIEW;
  const invalidDraft = {
    ...validDraft,
    release_items: [validDraft.release_items[0]],
  };
  const userFacingEvidence = {
    ...evidence,
    has_user_facing_product_changes: true,
  };

  let callCount = 0;
  try {
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = "https://example.invalid/internal/release-notes/draft";
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    delete process.env.ALLOW_OFFLINE_DOCS_PREVIEW;
    globalThis.fetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(callCount < 4 ? invalidDraft : validDraft),
      };
    };

    const draft = await requestDocAgentDraft(userFacingEvidence);

    assert.equal(callCount, 4);
    assert.equal(draft.validation_attempt_count, 4);
    assert.equal(draft.repair_attempt_count, 3);
    assert.equal(draft.validation_report.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL;
    else process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN;
    else process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = originalToken;
    if (originalOffline === undefined) delete process.env.ALLOW_OFFLINE_DOCS_PREVIEW;
    else process.env.ALLOW_OFFLINE_DOCS_PREVIEW = originalOffline;
  }
});

test("real weekly release skips Doc Agent drafting when local_plugin_version is blank", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  try {
    globalThis.fetch = async () => {
      callCount += 1;
      throw new Error("Doc Agent must not be called");
    };
    const draft = await requestDocAgentDraft({
      ...evidence,
      dry_run: false,
      local_plugin_release_requested: false,
      pending_local_plugin_changes: true,
      has_user_facing_product_changes: true,
    });
    assert.equal(callCount, 0);
    assert.equal(draft.ok, true);
    assert.deepEqual(draft.release_items, []);
    assert.match(draft.warnings[0], /left local_plugin_version blank/);
    const validation = validateDraft(draft, {
      ...evidence,
      dry_run: false,
      local_plugin_release_requested: false,
      pending_local_plugin_changes: true,
      has_user_facing_product_changes: true,
    });
    assert.equal(validation.ok, true);
    assert.equal(validation.skipped_by_operator, true);
    assert.equal(validation.coverage.required_count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed when the draft service exhausts all repair attempts", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL;
  const originalToken = process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN;
  const originalOffline = process.env.ALLOW_OFFLINE_DOCS_PREVIEW;
  const invalidDraft = {
    ...validDraft,
    release_items: [validDraft.release_items[0]],
  };
  const userFacingEvidence = {
    ...evidence,
    has_user_facing_product_changes: true,
  };

  let callCount = 0;
  try {
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = "https://example.invalid/internal/release-notes/draft";
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    delete process.env.ALLOW_OFFLINE_DOCS_PREVIEW;
    globalThis.fetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(invalidDraft),
      };
    };

    await assert.rejects(
      () => requestDocAgentDraft(userFacingEvidence),
      /Doc Agent draft failed validation after 3 repair attempts/,
    );
    assert.equal(callCount, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL;
    else process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN;
    else process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = originalToken;
    if (originalOffline === undefined) delete process.env.ALLOW_OFFLINE_DOCS_PREVIEW;
    else process.env.ALLOW_OFFLINE_DOCS_PREVIEW = originalOffline;
  }
});

test("builds Plugin tab previews without exposing source refs in page content", () => {
  const preview = buildDocsPreview(validDraft, evidence);
  assert.equal(preview.source_id, "openclaw-local-plugin");
  assert.equal(preview.source_repo, "MemTensor/MemOS");
  assert.equal(preview.previous_tag, "v2.0.24");
  assert.equal(preview.current_tag, "v2.0.25");
  assert.equal(preview.memos_release_tag, "v2.0.25");
  assert.equal(preview.local_plugin_version, "v2.0.11");
  assert.equal(preview.local_plugin_previous_version, "v2.0.10");
  assert.equal(preview.would_create_docs_pr, false);
  assert.deepEqual(preview.files, ["content/cn/plugin-changelog.yml", "content/en/plugin-changelog.yml"]);
  assert.equal(preview.cn.name, "v2.0.11");
  assert.equal(preview.cn.source.repo, "MemTensor/MemOS");
  assert.equal(preview.cn.source.memos_release_tag, "v2.0.25");
  assert.equal(preview.cn.source.local_plugin_version, "v2.0.11");
  assert.deepEqual(preview.cn.source.product_paths, ["apps/memos-local-plugin/**"]);
  assert.equal(preview.cn.products.plugin["New Features"][0].type, "MemOS 本地插件");
  assert.equal(preview.en.products.plugin.Improvements[0].type, "MemOS Local Plugin");

  const markdown = docsPreviewMarkdown(preview, validDraft, evidence);
  assert.match(markdown, /MemOS 本地插件-v2\.0\.11/);
  assert.match(markdown, /memos_release_range: v2\.0\.24\.\.\.v2\.0\.25/);
  assert.match(markdown, /Source Refs/);
  assert.match(markdown, /9deb941e/);
  assert.match(markdown, /59c14746/);
});

test("allows an empty Plugin tab draft when a MemOS release has no local-plugin changes", () => {
  const noChangeEvidence = {
    ...evidence,
    has_product_changes: false,
    has_user_facing_product_changes: false,
    skip_reason: "no local plugin path changes in apps/memos-local-plugin/**",
    commits: [],
    important_commits: [],
    required_source_refs: [],
    changed_files: [],
  };
  const emptyDraft = { ok: true, needs_review: false, release_items: [] };
  const validation = validateDraft(emptyDraft, noChangeEvidence);
  assert.equal(validation.ok, true);
  assert.equal(validation.coverage.required_count, 0);

  const preview = buildDocsPreview(emptyDraft, noChangeEvidence);
  assert.equal(preview.docs_action, "skip_plugin_tab_entry");
  assert.equal(preview.skip_reason, "no local plugin path changes in apps/memos-local-plugin/**");
  assert.deepEqual(preview.cn.products.plugin, {});
  assert.deepEqual(preview.en.products.plugin, {});
  const markdown = docsPreviewMarkdown(preview, emptyDraft, noChangeEvidence);
  assert.match(markdown, /no local plugin path changes/);
  assert.doesNotMatch(markdown, /Source Refs/);
});

test("skips Plugin tab docs when local-plugin changes are maintenance-only", () => {
  withFixtureRepo(() => {
    writeRepoFile("apps/memos-local-plugin/src/index.test.js", "export const coversSmokePath = true;\n");
    commitAll("test(plugin): cover standalone bridge smoke path (#10)");

    const result = collectLocalPluginEvidence({
      previousTag: "v9.9.0",
      currentTag: "v9.9.1",
      currentRef: "HEAD",
      targetVersion: "9.9.1",
      repo: "MemTensor/MemOS",
    });

    assert.equal(result.has_product_changes, true);
    assert.equal(result.has_user_facing_product_changes, false);
    assert.match(result.skip_reason, /no user-facing/);
    assert.deepEqual(result.important_commits, []);

    const emptyDraft = { ok: true, needs_review: false, release_items: [] };
    const validation = validateDraft(emptyDraft, result);
    assert.equal(validation.ok, true);

    const preview = buildDocsPreview(emptyDraft, result);
    assert.equal(preview.docs_action, "skip_plugin_tab_entry");
    assert.deepEqual(preview.cn.products.plugin, {});
    assert.deepEqual(preview.en.products.plugin, {});
    assert.match(docsPreviewMarkdown(preview, emptyDraft, result), /no user-facing/);
  });
});
