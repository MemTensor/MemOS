import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  PRODUCT_ID,
  RELEASE_NOTE_METHODS,
  buildDocsPreview,
  collectLocalPluginEvidence,
  compareSemver,
  cleanLocalPluginVersion,
  cleanVersion,
  docsPreviewMarkdown,
  existingReleaseTagState,
  fallbackTopicForText,
  findPreviousMemOSTag,
  generateGitHubReleaseNotes,
  incrementPatchVersion,
  requestDocAgentDraft,
  sourceRefsFromText,
  validateDraft,
  validateLocalPluginVersionPlan,
  validatePublishConfirmation,
  validateReleaseTarget,
} from "./prepare-memos-release.mjs";

const evidence = {
  repo: "MemTensor/MemOS",
  previous_tag: "v2.0.24",
  current_tag: "v2.0.25",
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
  assert.equal(incrementPatchVersion("2.0.12"), "2.0.13");
  assert.throws(() => incrementPatchVersion("2.0.12-beta.1"), /Cannot auto-increment prerelease/);
});

test("resolves the local plugin docs version from package or auto patch increment", () => {
  assert.deepEqual(validateLocalPluginVersionPlan(evidence, ""), {
    ok: true,
    expected_version: "",
    previous_version: "v2.0.10",
    version: "v2.0.11",
    version_changed: true,
    version_required: true,
    version_source: "apps/memos-local-plugin/package.json",
    auto_incremented: false,
    input_ignored: false,
    input_ignored_reason: "",
    input_raw: "",
    package_previous_version: "v2.0.10",
    package_version: "v2.0.11",
    package_version_changed: true,
  });
  assert.deepEqual(validateLocalPluginVersionPlan(evidence, "2.0.11"), {
    ok: true,
    expected_version: "v2.0.11",
    previous_version: "v2.0.10",
    version: "v2.0.11",
    version_changed: true,
    version_required: true,
    version_source: "apps/memos-local-plugin/package.json",
    auto_incremented: false,
    input_ignored: false,
    input_ignored_reason: "",
    input_raw: "2.0.11",
    package_previous_version: "v2.0.10",
    package_version: "v2.0.11",
    package_version_changed: true,
  });
  assert.throws(() => validateLocalPluginVersionPlan(evidence, "2.0.12"), /does not match/);

  assert.deepEqual(
    validateLocalPluginVersionPlan({
      ...evidence,
      local_plugin_previous_version: "v2.0.10",
      local_plugin_previous_version_raw: "2.0.10",
      local_plugin_version: "v2.0.10",
      local_plugin_version_raw: "2.0.10",
      local_plugin_version_changed: false,
      local_plugin_package_version: "v2.0.10",
      local_plugin_package_version_raw: "2.0.10",
      local_plugin_package_version_changed: false,
    }),
    {
      ok: true,
      expected_version: "",
      previous_version: "v2.0.10",
      version: "v2.0.11",
      version_changed: true,
      version_required: true,
      version_source: "auto_patch_from_previous_released_version",
      auto_incremented: true,
      input_ignored: false,
      input_ignored_reason: "",
      input_raw: "",
      package_previous_version: "v2.0.10",
      package_version: "v2.0.10",
      package_version_changed: false,
    },
  );
  assert.doesNotThrow(() =>
    validateLocalPluginVersionPlan(
      {
        ...evidence,
        local_plugin_previous_version: "v2.0.10",
        local_plugin_previous_version_raw: "2.0.10",
        local_plugin_version: "v2.0.10",
        local_plugin_version_raw: "2.0.10",
        local_plugin_version_changed: false,
        local_plugin_package_version: "v2.0.10",
        local_plugin_package_version_raw: "2.0.10",
        local_plugin_package_version_changed: false,
      },
      "2.0.11",
    ),
  );
  assert.throws(
    () =>
      validateLocalPluginVersionPlan(
        {
          ...evidence,
          local_plugin_previous_version: "v2.0.10",
          local_plugin_previous_version_raw: "2.0.10",
          local_plugin_version: "v2.0.10",
          local_plugin_version_raw: "2.0.10",
          local_plugin_version_changed: false,
          local_plugin_package_version: "v2.0.10",
          local_plugin_package_version_raw: "2.0.10",
          local_plugin_package_version_changed: false,
        },
        "2.0.12",
      ),
    /does not match/,
  );
  assert.deepEqual(
    validateLocalPluginVersionPlan({
      ...evidence,
      has_user_facing_product_changes: false,
      local_plugin_previous_version: "v2.0.10",
      local_plugin_previous_version_raw: "2.0.10",
      local_plugin_version: "v2.0.10",
      local_plugin_version_raw: "2.0.10",
      local_plugin_version_changed: false,
      local_plugin_package_version: "v2.0.10",
      local_plugin_package_version_raw: "2.0.10",
      local_plugin_package_version_changed: false,
    }),
    {
      ok: true,
      expected_version: "",
      previous_version: "v2.0.10",
      version: "v2.0.10",
      version_changed: false,
      version_required: false,
      version_source: "no_user_facing_product_changes",
      auto_incremented: false,
      input_ignored: false,
      input_ignored_reason: "",
      input_raw: "",
      package_previous_version: "v2.0.10",
      package_version: "v2.0.10",
      package_version_changed: false,
    },
  );
  assert.throws(
    () =>
      validateLocalPluginVersionPlan({
        ...evidence,
        local_plugin_package_previous_version: "v2.0.10",
        local_plugin_package_previous_version_raw: "2.0.10",
        local_plugin_package_version: "v2.0.9",
        local_plugin_package_version_raw: "2.0.9",
      }),
    /moved backwards/,
  );
});

test("ignores local plugin version input when the release has no local-plugin path changes", () => {
  assert.deepEqual(
    validateLocalPluginVersionPlan(
      {
        ...evidence,
        has_product_changes: false,
        has_user_facing_product_changes: false,
        local_plugin_previous_version: "v2.0.10",
        local_plugin_previous_version_raw: "2.0.10",
        local_plugin_version: "v2.0.10",
        local_plugin_version_raw: "2.0.10",
        local_plugin_version_changed: false,
        local_plugin_package_version: "v2.0.10",
        local_plugin_package_version_raw: "2.0.10",
        local_plugin_package_version_changed: false,
      },
      "v9.9.9",
    ),
    {
      ok: true,
      expected_version: "",
      previous_version: "v2.0.10",
      version: "v2.0.10",
      version_changed: false,
      version_required: false,
      version_source: "no_product_path_changes",
      auto_incremented: false,
      input_ignored: true,
      input_ignored_reason: "no local plugin path changes in apps/memos-local-plugin/**",
      input_raw: "v9.9.9",
      package_previous_version: "v2.0.10",
      package_version: "v2.0.10",
      package_version_changed: false,
    },
  );
});

test("ignores local plugin version input for maintenance-only local-plugin changes", () => {
  assert.deepEqual(
    validateLocalPluginVersionPlan(
      {
        ...evidence,
        has_product_changes: true,
        has_user_facing_product_changes: false,
        local_plugin_previous_version: "v2.0.10",
        local_plugin_previous_version_raw: "2.0.10",
        local_plugin_version: "v2.0.10",
        local_plugin_version_raw: "2.0.10",
        local_plugin_version_changed: false,
        local_plugin_package_version: "v2.0.12",
        local_plugin_package_version_raw: "2.0.12",
        local_plugin_package_version_changed: true,
      },
      "2.0.12",
    ),
    {
      ok: true,
      expected_version: "",
      previous_version: "v2.0.10",
      version: "v2.0.10",
      version_changed: false,
      version_required: false,
      version_source: "no_user_facing_product_changes",
      auto_incremented: false,
      input_ignored: true,
      input_ignored_reason: "local plugin path changed, but no user-facing feature/fix/performance evidence was found",
      input_raw: "2.0.12",
      package_previous_version: "v2.0.10",
      package_version: "v2.0.12",
      package_version_changed: true,
    },
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
});

test("publish workflow defaults real releases to draft before release.published", () => {
  const workflow = readFileSync(".github/workflows/memos-release-publish.yml", "utf8");
  assert.match(workflow, /create_draft_release:/);
  assert.match(workflow, /default:\s+true/);
  assert.match(workflow, /CREATE_DRAFT_RELEASE/);
  assert.match(workflow, /flags\+=\(--draft\)/);
  assert.match(workflow, /Publish manually to trigger release\.published/);
});

test("legacy standalone local-plugin publisher requires an extra non-dry-run confirmation", () => {
  const workflow = readFileSync(".github/workflows/memos-local-plugin-publish.yml", "utf8");
  assert.match(workflow, /legacy_publish_confirmation:/);
  assert.match(workflow, /guard-legacy-publish:/);
  assert.match(workflow, /expected="LEGACY PUBLISH memos-local-plugin-v\$\{RELEASE_VERSION\}"/);
  assert.match(workflow, /current official path is MemOS Release — Publish/);
  assert.match(workflow, /needs: guard-legacy-publish/);
});

test("inspection artifact contract includes generic aliases and side-effect proof", () => {
  const script = readFileSync(".github/scripts/prepare-memos-release.mjs", "utf8");
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

    git(["revert", "--no-edit", featureSha]);
    git([
      "commit",
      "--amend",
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

test("GitHub release notes fallback stays whole-repo when API access is unavailable", async () => {
  const result = await generateGitHubReleaseNotes({
    repo: "MemTensor/MemOS",
    currentTag: "v0.0.0-test",
    targetSha: "HEAD",
    previousTag: "HEAD",
    token: "",
  });
  assert.equal(result.source, "local-fallback-after-github-error");
  assert.match(result.body, /## What's Changed/);
  assert.match(result.body, /Full Changelog/);
  assert.doesNotMatch(result.body, /source_refs/);
  assert.doesNotMatch(result.body, /doc-agent-release-notes-json/);
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
