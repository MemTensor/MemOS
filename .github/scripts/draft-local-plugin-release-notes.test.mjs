import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanVersion,
  categoryHintsForCommits,
  compareSemver,
  docsPreviewFromDraft,
  draftForInspection,
  evidenceForInspection,
  ensureSourceHint,
  findPreviousTag,
  markdownFromDocsPreview,
  main,
  RELEASE_NOTE_QUALITY_REQUEST,
  RELEASE_NOTE_GUIDANCE,
  postprocessDraftFromEvidence,
  reportExternalFailureFromEnv,
  requestDraft,
  requestValidatedDraft,
  resolveCurrentRef,
  validateManualNotes,
  versionFromTag,
} from "./draft-local-plugin-release-notes.mjs";

const evidence = {
  repo: "MemTensor/MemOS",
  current_tag: "memos-local-plugin-v2.0.10",
  target_version: "v2.0.10",
};

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

test("normalizes only real local-plugin tag families", () => {
  assert.equal(cleanVersion("v2.0.10"), "2.0.10");
  assert.equal(versionFromTag("memos-local-plugin-v2.0.10"), "2.0.10");
  assert.equal(versionFromTag("openclaw-local-plugin-v2.0.9"), "2.0.9");
  assert.equal(versionFromTag("v2.0.10"), "");
});

test("compares SemVer prerelease identifiers numerically and ignores build metadata", () => {
  assert.equal(compareSemver("2.0.0-beta.10", "2.0.0-beta.9") > 0, true);
  assert.equal(compareSemver("2.0.0-beta.20", "2.0.0-beta.19") > 0, true);
  assert.equal(compareSemver("2.0.0", "2.0.0-beta.99") > 0, true);
  assert.equal(compareSemver("2.0.0-beta.1+build.2", "2.0.0-beta.1+build.1"), 0);
  assert.equal(compareSemver("2.0.0-alpha.1", "2.0.0-alpha.beta") < 0, true);
});

test("finds previous local-plugin tags using SemVer precedence for prerelease numbers", () => {
  const tmp = mkdtempSync(join(tmpdir(), "local-plugin-semver-tags-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(tmp);
    assert.equal(execFileSync("git", ["init"], { encoding: "utf8" }).includes("Initialized"), true);
    execFileSync("git", ["config", "user.name", "test"], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { stdio: "ignore" });
    writeFileSync("package.json", '{"private":true}\n', "utf8");
    execFileSync("git", ["add", "package.json"], { stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { stdio: "ignore" });
    for (const tag of [
      "memos-local-plugin-v2.0.0-beta.1",
      "memos-local-plugin-v2.0.0-beta.2",
      "memos-local-plugin-v2.0.0-beta.9",
      "memos-local-plugin-v2.0.0-beta.10",
      "memos-local-plugin-v2.0.0-beta.19",
      "openclaw-local-plugin-v2.0.0-beta.18",
    ]) {
      execFileSync("git", ["tag", tag], { stdio: "ignore" });
    }

    assert.equal(findPreviousTag("2.0.0-beta.10", "memos-local-plugin-v2.0.0-beta.10"), "memos-local-plugin-v2.0.0-beta.9");
    assert.equal(findPreviousTag("2.0.0-beta.20", "memos-local-plugin-v2.0.0-beta.20"), "memos-local-plugin-v2.0.0-beta.19");
  } finally {
    process.chdir(previousCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("uses an existing release tag as the evidence endpoint", () => {
  const exists = (ref) => ref === "memos-local-plugin-v2.0.10" || ref === "manual-ref";
  assert.equal(
    resolveCurrentRef("memos-local-plugin-v2.0.10", { requestedRef: "", refExistsImpl: exists }),
    "memos-local-plugin-v2.0.10",
  );
  assert.equal(
    resolveCurrentRef("memos-local-plugin-v2.0.11", { requestedRef: "", refExistsImpl: exists }),
    "HEAD",
  );
  assert.equal(
    resolveCurrentRef("memos-local-plugin-v2.0.11", { requestedRef: "manual-ref", refExistsImpl: exists }),
    "manual-ref",
  );
  assert.throws(
    () => resolveCurrentRef("memos-local-plugin-v2.0.11", { requestedRef: "missing-ref", refExistsImpl: exists }),
    /RELEASE_EVIDENCE_REF does not exist/,
  );
});

test("documents release-note category guidance for the draft service", () => {
  assert.match(RELEASE_NOTE_GUIDANCE.category_policy.Added, /configuration/);
  assert.match(RELEASE_NOTE_GUIDANCE.category_policy.Improved, /performance optimization/);
  assert.match(RELEASE_NOTE_GUIDANCE.category_policy.Fixed, /broken behavior/);
  assert.ok(
    RELEASE_NOTE_GUIDANCE.quality_policy.some((item) =>
      item.includes("Do not collapse a new configuration capability and a bug fix"),
    ),
  );
  assert.ok(
    RELEASE_NOTE_GUIDANCE.translation_policy.some((item) =>
      item.includes("Treat text_cn as the canonical release-note wording first"),
    ),
  );
});

test("requests multi-candidate draft quality checks from the draft service", () => {
  assert.equal(RELEASE_NOTE_QUALITY_REQUEST.candidate_count, 3);
  assert.equal(RELEASE_NOTE_QUALITY_REQUEST.repair_policy.max_repair_attempts, 3);
  assert.ok(
    RELEASE_NOTE_QUALITY_REQUEST.selection_policy.some((item) =>
      item.includes("docs-preview readability"),
    ),
  );
});

test("adds source-ref category hints from commit subjects", () => {
  const hints = categoryHintsForCommits([
    {
      short_sha: "59c14746",
      subject: "Fix #2076: local-plugin gateway CPU 100% — synchronous full-table vector scan (#2077)",
    },
    {
      short_sha: "9deb941e",
      subject: "feat(l3): dedicated l3Llm config slot for abstraction pass (#1959)",
    },
    {
      short_sha: "de03ab29",
      subject: "Fix #2063: algorithm.lightweightMemory.enabled: true does not actually skip evolution pipeline (#2074)",
    },
    {
      short_sha: "78ae7a53",
      subject: "fix(memos-local-plugin): handle full endpoint paths in openai_compatible probe",
    },
    {
      short_sha: "c739e9f2",
      subject: "fix: ruff",
    },
    {
      short_sha: "ca2b3854",
      subject: "fix(memos): apply Memtensor-AI review feedback to PR #1817",
    },
  ]);
  assert.deepEqual(
    hints.map((hint) => hint.category),
    ["Improved", "Added", "Fixed", "Fixed"],
  );
  assert.deepEqual(hints[0].source_refs, ["59c14746", "#2076", "#2077"]);
  assert.deepEqual(hints[2].source_refs, ["de03ab29", "#2063", "#2074"]);
});

test("redacts full diff and prompt guidance from inspection evidence", () => {
  const inspection = evidenceForInspection({
    ...evidence,
    release_note_guidance: {
      category_policy: { Added: "private prompt details" },
      quality_policy: ["private quality prompt"],
      translation_policy: ["private translation prompt"],
      source_ref_category_hints: [{ category: "Added", source_refs: ["abc1234"] }],
    },
    important_diff: {
      "apps/memos-local-plugin/**": "diff --git a/private.js b/private.js",
    },
  });

  assert.equal("important_diff" in inspection, false);
  assert.equal(inspection.release_note_guidance.category_policy, undefined);
  assert.deepEqual(inspection.release_note_guidance.source_ref_category_hints, [
    { category: "Added", source_refs: ["abc1234"] },
  ]);
  assert.match(inspection.redactions.important_diff, /omitted/);
});

test("redacts server debug fields from inspection draft", () => {
  const inspection = draftForInspection({
    ok: true,
    needs_review: false,
    confidence: "high",
    release_items: [{ category: "Added", text_cn: "新增配置", text_en: "Added configuration", source_refs: ["abc1234"] }],
    coverage: { needs_review: false, required_count: 1, covered_required_count: 1, covered_refs: ["abc1234"] },
    model: "private-model",
    prompt: "private prompt",
    debug: { trace: "private debug" },
  });

  assert.equal(inspection.model, undefined);
  assert.equal(inspection.prompt, undefined);
  assert.equal(inspection.debug, undefined);
  assert.deepEqual(inspection.release_items[0].source_refs, ["abc1234"]);
  assert.match(inspection.redactions.model_and_prompt_details, /omitted/);
});

test("renders a docs plugin changelog preview from normalized release items", () => {
  const draft = {
    docs_categories: {
      cn: {
        "New Features": [
          "**轻量记忆配置**：新增轻量记忆配置入口，便于在轻量场景下降低后台处理开销。",
        ],
      },
      en: {
        "New Features": [
          "**Lightweight Memory Configuration**: Added a lightweight-memory configuration entry for lower-overhead local runs.",
        ],
      },
    },
  };
  const preview = docsPreviewFromDraft(draft, {
    targetVersion: "2.0.10",
    publishedAt: "2026-07-20T08:00:00Z",
  });
  const markdown = markdownFromDocsPreview(preview);

  assert.equal(preview.version, "v2.0.10");
  assert.equal(preview.date, "2026-07-20");
  assert.equal(preview.docs_files.cn, "content/cn/plugin-changelog.yml");
  assert.equal(preview.entries.cn.products.plugin["New Features"][0].type, "OpenClaw 本地插件");
  assert.equal(preview.entries.en.products.plugin["New Features"][0].type, "OpenClaw Local Plugin");
  assert.match(markdown, /中文预览/);
  assert.match(markdown, /Lightweight Memory Configuration/);
});

test("postprocesses duplicate source refs into the best evidence category", () => {
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Fixed",
          text_cn: "**修复 CPU 占用**：解决同步全表向量扫描导致的 CPU 100%。",
          text_en: "**CPU Fix**: Fixed CPU usage from synchronous vector scans.",
          source_refs: ["59c14746", "#2077"],
        },
        {
          category: "Improved",
          text_cn: "**向量扫描优化**：降低向量扫描 CPU 压力。",
          text_en: "**Vector scan**: Reduced vector-scan CPU pressure.",
          source_refs: ["59c14746", "#2077"],
        },
        {
          category: "Fixed",
          text_cn: "**记忆与 LLM 调用稳定性**：补强空响应重试、错误日志、XML 上下文边界和脏奖励恢复场景处理。",
          text_en:
            "**Memory and LLM Stability**: Improved empty-response retry, error logging, XML boundaries, and dirty-reward recovery.",
          source_refs: ["2c48b496", "#2064", "e5080657", "#2052"],
        },
        {
          category: "Improved",
          text_cn: "**检索上下文边界优化**：使用 XML 边界组织记忆上下文。",
          text_en: "**Context boundaries**: Organized memory context with XML boundaries.",
          source_refs: ["e5080657", "#2052"],
        },
      ],
      coverage: { required_count: 3, covered_required_count: 3, missing_required_count: 0 },
      warnings: [],
    },
    {
      commits: [
        {
          sha: "59c1474600000000000000000000000000000000",
          short_sha: "59c14746",
          subject: "Fix #2076: local-plugin gateway CPU 100% — synchronous full-table vector scan (#2077)",
        },
        {
          sha: "2c48b49600000000000000000000000000000000",
          short_sha: "2c48b496",
          subject: "fix(skill-crystallize): retry with context when LLM returns empty response (#2064)",
        },
        {
          sha: "e508065700000000000000000000000000000000",
          short_sha: "e5080657",
          subject: "fix: delimit memory context with XML boundary (#2052)",
        },
      ],
      release_note_guidance: {
        source_ref_category_hints: [
          {
            category: "Improved",
            source_refs: ["59c14746", "#2076", "#2077"],
            subject: "Fix #2076: local-plugin gateway CPU 100% — synchronous full-table vector scan (#2077)",
          },
          {
            category: "Fixed",
            source_refs: ["2c48b496", "#2064"],
            subject: "fix(skill-crystallize): retry with context when LLM returns empty response (#2064)",
          },
          {
            category: "Improved",
            source_refs: ["e5080657", "#2052"],
            subject: "fix: delimit memory context with XML boundary (#2052)",
          },
        ],
      },
    },
  );

  assert.equal(processed.needs_review, false);
  assert.equal(processed.coverage.covered_required_count, 3);
  assert.equal(processed.postprocess.removed_duplicate_source_refs, 4);
  assert.equal(processed.postprocess.dropped_empty_source_items, 1);
  assert.equal(processed.release_items.length, 3);
  assert.deepEqual(
    processed.release_items.map((item) => item.category),
    ["Improved", "Fixed", "Improved"],
  );
  assert.equal(
    processed.release_items.filter((item) => item.source_refs.includes("59c14746")).length,
    1,
  );
  assert.equal(
    processed.release_items.find((item) => item.text_cn.includes("记忆恢复"))?.text_cn.includes("XML"),
    false,
  );
  assert.match(processed.release_notes_markdown, /doc-agent-release-notes-json/);
});

test("postprocesses a single misclassified performance item into Improved", () => {
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Fixed",
          text_cn: "**修复 CPU 占用**：解决同步全表向量扫描导致的 CPU 100%。",
          text_en: "**CPU Fix**: Fixed CPU usage from synchronous vector scans.",
          source_refs: ["59c14746", "#2077"],
        },
      ],
      coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
      warnings: [],
    },
    {
      commits: [
        {
          sha: "59c1474600000000000000000000000000000000",
          short_sha: "59c14746",
          subject: "Fix #2076: local-plugin gateway CPU 100% — synchronous full-table vector scan (#2077)",
        },
      ],
      release_note_guidance: {
        source_ref_category_hints: [
          {
            category: "Improved",
            source_refs: ["59c14746", "#2076", "#2077"],
            subject: "Fix #2076: local-plugin gateway CPU 100% — synchronous full-table vector scan (#2077)",
          },
        ],
      },
    },
  );

  assert.equal(processed.release_items[0].category, "Improved");
  assert.match(processed.release_items[0].text_cn, /向量扫描性能优化/);
  assert.match(processed.release_notes_markdown, /### Improved/);
});

test("postprocesses mixed endpoint and auth fixes without dropping either concern", () => {
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Fixed",
          text_cn: "**桥接与连接稳定性**：优化 RPC 会话豁免和 OpenAI-compatible 端点探测。",
          text_en: "**Bridge and connection stability**: Improved RPC exemption and endpoint probing.",
          source_refs: ["4afaa3ce", "78ae7a53"],
        },
      ],
      coverage: { required_count: 2, covered_required_count: 2, missing_required_count: 0 },
      warnings: [],
    },
    {
      commits: [
        {
          sha: "4afaa3ce00000000000000000000000000000000",
          short_sha: "4afaa3ce",
          subject: "fix(auth): restrict /api/v1/rpc session exemption to loopback callers",
        },
        {
          sha: "78ae7a5300000000000000000000000000000000",
          short_sha: "78ae7a53",
          subject: "fix(memos-local-plugin): handle full endpoint paths in openai_compatible probe",
        },
      ],
      release_note_guidance: {
        source_ref_category_hints: [
          {
            category: "Fixed",
            source_refs: ["4afaa3ce"],
            subject: "fix(auth): restrict /api/v1/rpc session exemption to loopback callers",
          },
          {
            category: "Fixed",
            source_refs: ["78ae7a53"],
            subject: "fix(memos-local-plugin): handle full endpoint paths in openai_compatible probe",
          },
        ],
      },
    },
  );

  assert.match(processed.release_items[0].text_cn, /连接与鉴权边界修复/);
  assert.match(processed.release_items[0].text_cn, /endpoint/);
  assert.match(processed.release_items[0].text_cn, /RPC/);
});

test("postprocess fails closed when English and Chinese text cross languages", () => {
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Added",
          text_cn: "Plugin health dashboard",
          text_en: "插件健康看板",
          source_refs: ["abc1234", "#3001"],
        },
      ],
      coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
      warnings: [],
    },
    {
      commits: [
        {
          sha: "abc12340000000000000000000000000000000",
          short_sha: "abc1234",
          subject: "feat: add plugin health dashboard (#3001)",
        },
      ],
      release_note_guidance: {
        source_ref_category_hints: [
          {
            category: "Added",
            source_refs: ["abc1234", "#3001"],
            subject: "feat: add plugin health dashboard (#3001)",
          },
        ],
      },
    },
  );

  assert.equal(processed.ok, false);
  assert.equal(processed.needs_review, true);
  assert.equal(processed.language_issues.length, 2);
});

test("repairs postprocessed language validation issues with exact context", async () => {
  const repairEvidence = {
    commits: [
      {
        sha: "abc12340000000000000000000000000000000",
        short_sha: "abc1234",
        subject: "feat: add plugin health dashboard (#3001)",
      },
    ],
    release_note_guidance: {
      source_ref_category_hints: [
        {
          category: "Added",
          source_refs: ["abc1234", "#3001"],
          subject: "feat: add plugin health dashboard (#3001)",
        },
      ],
    },
  };
  const requests = [];
  const requestImpl = async (payload) => {
    requests.push(payload);
    if (requests.length === 1) {
      return {
        ok: true,
        needs_review: false,
        release_items: [
          {
            category: "Added",
            text_cn: "Plugin health dashboard",
            text_en: "插件健康看板",
            source_refs: ["abc1234", "#3001"],
          },
        ],
        coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
        warnings: [],
      };
    }
    return {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Added",
          text_cn: "**插件健康看板**：新增本地插件健康状态展示。",
          text_en: "**Plugin Health Dashboard**: Added local plugin health status visibility.",
          source_refs: ["abc1234", "#3001"],
        },
      ],
      coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
      warnings: [],
    };
  };

  const result = await requestValidatedDraft(repairEvidence, { requestImpl });

  assert.equal(result.ok, true);
  assert.equal(result.needs_review, false);
  assert.equal(result.repair_attempt_count, 1);
  assert.equal(result.validation_attempt_count, 2);
  assert.equal(result.validation_report.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].release_notes_repair_context.validation_report.language_issue_count, 2);
  assert.deepEqual(
    requests[1].release_notes_repair_context.validation_report.issues.map((issue) => issue.field),
    ["text_cn", "text_en"],
  );
  assert.equal(requests[1].release_notes_repair_context.previous_release_items[0].source_refs[0], "abc1234");
  assert.match(result.release_notes_markdown, /插件健康看板/);
  assert.match(result.release_notes_markdown, /doc-agent-release-notes-json/);
});

test("stops release-note repair after two validation repair attempts", async () => {
  const repairEvidence = {
    commits: [
      {
        sha: "abc12340000000000000000000000000000000",
        short_sha: "abc1234",
        subject: "feat: add plugin health dashboard (#3001)",
      },
    ],
    release_note_guidance: {
      source_ref_category_hints: [
        {
          category: "Added",
          source_refs: ["abc1234", "#3001"],
          subject: "feat: add plugin health dashboard (#3001)",
        },
      ],
    },
  };
  const requests = [];
  const crossedDraft = {
    ok: true,
    needs_review: false,
    release_items: [
      {
        category: "Added",
        text_cn: "Plugin health dashboard",
        text_en: "插件健康看板",
        source_refs: ["abc1234", "#3001"],
      },
    ],
    coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
    warnings: [],
  };
  const requestImpl = async (payload) => {
    requests.push(payload);
    return crossedDraft;
  };

  const result = await requestValidatedDraft(repairEvidence, { requestImpl, maxRepairAttempts: 2 });

  assert.equal(result.ok, false);
  assert.equal(result.needs_review, true);
  assert.equal(result.repair_attempt_count, 2);
  assert.equal(result.validation_attempt_count, 3);
  assert.equal(result.validation_report.language_issue_count, 2);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].release_notes_repair_context.repair_attempt, 1);
  assert.equal(requests[2].release_notes_repair_context.repair_attempt, 2);
});

test("reports three external-operation attempt logs with a sanitized phase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-plugin-release-failure-"));
  const previous = { ...process.env };
  try {
    for (const attempt of [1, 2, 3]) writeFileSync(join(directory, `${attempt}.log`), `npm failure ${attempt}`);
    Object.assign(process.env, {
      RELEASE_FAILURE_PHASE: "npm-publish",
      RELEASE_FAILURE_ATTEMPT_DIR: directory,
      RELEASE_VERSION: "2.0.10",
      RELEASE_TAG: "memos-local-plugin-v2.0.10",
      DOC_AGENT_RELEASE_FAILURE_URL: "https://example.invalid/failure",
      DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN: "test-token",
    });
    let report;
    await reportExternalFailureFromEnv({
      fetchImpl: async (_url, options) => { report = JSON.parse(options.body); return response(200, { ok: true }); },
    });
    assert.equal(report.phase, "npm-publish");
    assert.deepEqual(report.attempts.map((item) => item.message), ["npm failure 1", "npm failure 2", "npm failure 3"]);
  } finally {
    process.env = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual notes require bilingual evidence refs and passed coverage", () => {
  const valid = `## Changelog

### Added
- local memory

<!-- doc-agent-release-notes-json
{"items":[{"category":"Added","text_cn":"本地记忆","text_en":"Local memory","source_refs":["abc1234"]}],"coverage":{"needs_review":false}}
-->`;
  assert.equal(validateManualNotes(valid), valid);
  assert.match(ensureSourceHint(valid), /source-id=openclaw-local-plugin/);
  assert.throws(() => validateManualNotes("## Changelog\n- unsupported"), /evidence block/);
  assert.throws(
    () =>
      validateManualNotes(`## Changelog

### Added
- local memory

<!-- doc-agent-release-notes-json
{"items":[{"text_cn":"本地记忆","text_en":"Local memory","source_refs":["abc1234"]}],"coverage":{"needs_review":false}}
-->`),
    /category, text_cn, text_en, and valid source_refs/,
  );
  assert.throws(
    () =>
      validateManualNotes(`## Changelog

### Added
- local memory

<!-- doc-agent-release-notes-json
{"items":[{"category":"Added","text_cn":"Local memory","text_en":"本地记忆","source_refs":["abc1234"]}],"coverage":{"needs_review":false}}
-->`),
    /text_cn must contain Chinese/,
  );
});

test("manual release notes also produce docs preview outputs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-plugin-manual-preview-"));
  const previous = { ...process.env };
  try {
    const outputPath = join(directory, "github-output.txt");
    const notesPath = join(directory, "release-notes.md");
    Object.assign(process.env, {
      RELEASE_VERSION: "2.0.10",
      RELEASE_NOTES_FILE: notesPath,
      MANUAL_RELEASE_NOTES: `## Changelog

### Added
- **轻量记忆配置**：新增轻量记忆配置入口。

<!-- doc-agent-release-notes-json
{"items":[{"category":"Added","text_cn":"**轻量记忆配置**：新增轻量记忆配置入口。","text_en":"**Lightweight Memory Configuration**: Added a lightweight-memory configuration entry.","source_refs":["abc1234"]}],"coverage":{"needs_review":false,"required_count":1,"covered_required_count":1,"missing_required_count":0}}
-->`,
      GITHUB_OUTPUT: outputPath,
    });

    await main();

    const output = readFileSync(outputPath, "utf8");
    const match = output.match(/docs_preview_markdown_file<<__DOC_AGENT_EOF__\n([\s\S]*?)\n__DOC_AGENT_EOF__/);
    assert.ok(match, "docs preview markdown output should be written");
    const preview = readFileSync(match[1], "utf8");
    assert.match(preview, /MemOS-Docs Plugin Changelog Preview/);
    assert.match(preview, /OpenClaw 本地插件/);
    assert.match(preview, /Lightweight Memory Configuration/);
    assert.match(readFileSync(notesPath, "utf8"), /doc-agent: source-id=openclaw-local-plugin/);
  } finally {
    process.env = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retries transient draft failures and passes prior error context", async () => {
  const previous = { ...process.env };
  try {
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = "https://example.invalid/draft";
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    const requests = [];
    const fetchImpl = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length < 3) return response(503, { detail: "busy" });
      return response(200, {
        ok: true,
        needs_review: false,
        release_notes_markdown: "## Changelog\n\n### Added\n- ok",
      });
    };
    const result = await requestDraft(evidence, { fetchImpl, sleep: async () => {} });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 3);
    assert.equal(requests[1].workflow_retry_context.previous_errors.length, 1);
    assert.equal(requests[2].workflow_retry_context.previous_errors.length, 2);
  } finally {
    process.env = previous;
  }
});

test("reports once after three transient failures", async () => {
  const previous = { ...process.env };
  try {
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = "https://example.invalid/draft";
    process.env.DOC_AGENT_RELEASE_FAILURE_URL = "https://example.invalid/failure";
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.includes("/failure")) return response(200, { ok: true, sent: true });
      return response(503, { detail: "busy" });
    };
    await assert.rejects(
      requestDraft(evidence, { fetchImpl, sleep: async () => {} }),
      /attempt 3/,
    );
    const reports = calls.filter((call) => call.url.includes("/failure"));
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].body.attempts.map((item) => item.attempt), [1, 2, 3]);
    assert.equal(reports[0].body.repository, "MemTensor/MemOS");
  } finally {
    process.env = previous;
  }
});

test("requires configured draft URL instead of using a public fallback", async () => {
  const previous = { ...process.env };
  try {
    delete process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL;
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    await assert.rejects(
      requestDraft(evidence, { fetchImpl: async () => response(200, { ok: true }), sleep: async () => {} }),
      /DOC_AGENT_RELEASE_NOTES_DRAFT_URL secret is required/,
    );
  } finally {
    process.env = previous;
  }
});

test("sanitizes configured URLs and IPs before failure reporting", async () => {
  const previous = { ...process.env };
  try {
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = "https://example.invalid/draft";
    process.env.DOC_AGENT_RELEASE_FAILURE_URL = "https://example.invalid/failure";
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.includes("/failure")) return response(200, { ok: true, sent: true });
      throw Object.assign(
        new Error("connect ECONNREFUSED https://example.invalid/redacted-path with Bearer test-token"),
        { retryable: true },
      );
    };
    await assert.rejects(
      requestDraft(evidence, { fetchImpl, sleep: async () => {} }),
      /attempt 3/,
    );
    const report = calls.find((call) => call.url.includes("/failure"))?.body;
    assert.ok(report);
    assert.doesNotMatch(JSON.stringify(report), /example\.invalid|redacted-path|test-token/);
    assert.match(JSON.stringify(report), /https:\/\/\*\*\*/);
  } finally {
    process.env = previous;
  }
});
