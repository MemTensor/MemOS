import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanVersion,
  categoryHintsForCommits,
  draftForInspection,
  evidenceForInspection,
  ensureSourceHint,
  filterNetEffectiveCommits,
  isLegacyPackageOnlyRelease,
  legacyPackageDraftFromEvidence,
  manualDraftFromNotes,
  parseSemver,
  RELEASE_NOTE_GUIDANCE,
  postprocessDraftFromEvidence,
  releaseTopicsForCommits,
  compactReleaseTopics,
  releaseTopicLimitForRequiredCount,
  requireValidatedDraft,
  reportExternalFailureFromEnv,
  requestDraft,
  requestValidatedDraft,
  resolveCurrentRef,
  selectPreviousTag,
  validateLegacyPackageNotes,
  validateManualNotes,
  versionFromTag,
  writeDraftFailureInspection,
} from "./draft-local-plugin-release-notes.mjs";

const evidence = {
  repo: "MemTensor/MemOS",
  current_tag: "memos-local-plugin-v2.0.10",
  target_version: "v2.0.10",
};

function withGitHubRepository(repository, callback) {
  const previousRepository = process.env.GITHUB_REPOSITORY;
  try {
    if (repository) process.env.GITHUB_REPOSITORY = repository;
    else delete process.env.GITHUB_REPOSITORY;
    return callback();
  } finally {
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
  }
}

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

test("detects legacy package-only prereleases", () => {
  assert.equal(isLegacyPackageOnlyRelease({ targetVersion: "2.0.13-beta.1", npmDistTag: "beta" }), true);
  assert.equal(isLegacyPackageOnlyRelease({ targetVersion: "2.0.13-beta.1", npmDistTag: "latest" }), true);
  assert.equal(isLegacyPackageOnlyRelease({ targetVersion: "2.0.13", npmDistTag: "beta" }), true);
  assert.equal(isLegacyPackageOnlyRelease({ targetVersion: "2.0.13", npmDistTag: "next" }), true);
  assert.equal(isLegacyPackageOnlyRelease({ targetVersion: "2.0.13", npmDistTag: "latest" }), false);
  assert.equal(isLegacyPackageOnlyRelease({ targetVersion: "2.0.13", npmDistTag: "" }), false);
});

test("can force a stable standalone publish to remain package-only", () => {
  assert.equal(
    isLegacyPackageOnlyRelease({ targetVersion: "2.0.13", npmDistTag: "latest", forcePackageOnly: true }),
    true,
  );
  assert.equal(
    isLegacyPackageOnlyRelease({ targetVersion: "2.0.13", npmDistTag: "latest", forcePackageOnly: false }),
    false,
  );
});

test("treats SemVer build metadata as stable metadata, not a prerelease channel", () => {
  assert.equal(parseSemver("2.0.13+build.7").prerelease, "");
  assert.equal(parseSemver("2.0.13-beta.1+build.7").prerelease, "beta.1");
  assert.equal(isLegacyPackageOnlyRelease({ targetVersion: "2.0.13+build.7", npmDistTag: "latest" }), false);
  assert.equal(isLegacyPackageOnlyRelease({ targetVersion: "2.0.13-beta.1+build.7", npmDistTag: "latest" }), true);
});

test("uses the previous stable tag for docs-generating latest releases", () => {
  const tags = [
    { tag: "memos-local-plugin-v2.0.12", version: "2.0.12" },
    { tag: "memos-local-plugin-v2.0.13-beta.1", version: "2.0.13-beta.1" },
    { tag: "memos-local-plugin-v2.0.13", version: "2.0.13" },
  ];

  assert.equal(
    selectPreviousTag(tags, "2.0.13", "memos-local-plugin-v2.0.13", { includePrerelease: false }),
    "memos-local-plugin-v2.0.12",
  );
  assert.equal(
    selectPreviousTag(tags, "2.0.13", "memos-local-plugin-v2.0.13", { includePrerelease: true }),
    "memos-local-plugin-v2.0.13-beta.1",
  );
});

test("generates independent prerelease notes without docs payloads", () => {
  const draft = legacyPackageDraftFromEvidence(
    {
      current_tag: "memos-local-plugin-v2.0.13-beta.1",
      previous_tag: "memos-local-plugin-v2.0.12",
      target_version: "v2.0.13-beta.1",
      git_ref: "abc1234",
      changed_files: [{ status: "M", path: "apps/memos-local-plugin/package.json" }],
      commits: [
        {
          sha: "abc1234000000000000000000000000000000000",
          short_sha: "abc1234",
          subject: "test: prepare local plugin beta package",
        },
      ],
      package_changes: [{ field: "version", before: "2.0.12", after: "2.0.13-beta.1" }],
    },
    { npmDistTag: "beta" },
  );

  assert.equal(draft.ok, true);
  assert.equal(draft.needs_review, false);
  assert.equal(draft.confidence, "standalone-prerelease-no-docs");
  assert.equal(draft.coverage.missing_required_count, 0);
  assert.match(draft.release_notes_markdown, /## Changelog/);
  assert.match(draft.release_notes_markdown, /npm `beta` dist-tag/);
  assert.match(draft.release_notes_markdown, /independent local-plugin GitHub Prerelease/);
  assert.match(draft.release_notes_markdown, /does not update the MemOS-Docs Plugin tab/);
  assert.doesNotMatch(draft.release_notes_markdown, /doc-agent: source-id=/);
  assert.doesNotMatch(draft.release_notes_markdown, /doc-agent-release-notes-json/);
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
    {
      short_sha: "ab12cd34",
      subject: "adjust session checkpoint ownership for local plugin hosts",
    },
    {
      short_sha: "31976918",
      subject: "test(plugin): format Hermes UTF-8 regression",
    },
    {
      short_sha: "492bc844",
      subject: "test(hermes-adapter): add world_model coverage and drop fragile \\u check",
    },
  ]);
  assert.deepEqual(
    hints.map((hint) => hint.category),
    ["Improved", "Added", "Fixed", "Fixed", "Improved"],
  );
  assert.deepEqual(hints[0].source_refs, ["59c14746", "#2076", "#2077"]);
  assert.deepEqual(hints[2].source_refs, ["de03ab29", "#2063", "#2074"]);
  assert.equal(
    hints.some((hint) => hint.source_refs.includes("31976918") || hint.source_refs.includes("492bc844")),
    false,
    "test-only Hermes commits must not become required user-facing release topics",
  );
});

test("removes net-zero reverts while preserving reapplications and revert-of-revert effects", () => {
  const original = {
    sha: "1111111111111111111111111111111111111111",
    short_sha: "11111111",
    subject: "feat(plugin): add session checkpoint recovery",
    body: "",
  };
  const revert = {
    sha: "2222222222222222222222222222222222222222",
    short_sha: "22222222",
    subject: 'Revert "feat(plugin): add session checkpoint recovery"',
    body: `This reverts commit ${original.sha}.`,
  };
  const reapply = {
    sha: "3333333333333333333333333333333333333333",
    short_sha: "33333333",
    subject: "feat(plugin): restore session checkpoint recovery safely",
    body: "",
  };
  const revertOfRevert = {
    sha: "4444444444444444444444444444444444444444",
    short_sha: "44444444",
    subject: 'Revert "Revert session checkpoint recovery"',
    body: `This reverts commit ${revert.sha}.`,
  };

  assert.deepEqual(filterNetEffectiveCommits([revert, original]), []);
  assert.deepEqual(filterNetEffectiveCommits([reapply, revert, original]), [reapply]);
  assert.deepEqual(filterNetEffectiveCommits([revertOfRevert, revert, original]), [original]);
});

test("uses subject fallback for in-range reverts but keeps rollbacks of older releases", () => {
  const original = {
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    short_sha: "aaaaaaaa",
    subject: "fix(plugin): retain host input during recall",
    body: "",
  };
  const subjectOnlyRevert = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    short_sha: "bbbbbbbb",
    subject: 'Revert "fix(plugin): retain host input during recall"',
    body: "",
  };
  const priorReleaseRollback = {
    sha: "cccccccccccccccccccccccccccccccccccccccc",
    short_sha: "cccccccc",
    subject: 'Revert "feat(plugin): legacy behavior from an older release"',
    body: "This reverts commit dddddddddddddddddddddddddddddddddddddddd.",
  };

  assert.deepEqual(filterNetEffectiveCommits([subjectOnlyRevert, original]), []);
  assert.deepEqual(filterNetEffectiveCommits([priorReleaseRollback]), [priorReleaseRollback]);
  assert.deepEqual(categoryHintsForCommits([priorReleaseRollback])[0].category, "Fixed");
});

test("aggregates the v2.0.18 high-commit release into evidence-complete user topics", () => {
  const commits = [
    ["602f60ff", "fix(plugin): make free-form config paths explicit"],
    ["e1530908", "fix(plugin): scope secret environment fallbacks"],
    ["c6aaf9d3", "fix(plugin): use OS home for bridge PID fallback"],
    ["060859d0", "fix(plugin): run idle skill archival in background"],
    ["117b2a2d", "fix(plugin): recover gateway after installer failures"],
    ["fa4bb36b", "fix(hermes-adapter): pass ensure_ascii=False in handle_tool_call json.dumps (#2255)"],
    ["763ca1fc", "fix(skill): auto-generate crystallizer summary/steps instead of rejecting"],
    ["2b726985", "fix(plugin): default headers {} on l3Llm/skillEvolver slots; maxTokens floor 100"],
    ["5fd49171", "fix(core): bound startup recovery wait in shutdown to 15s"],
    ["10786401", "fix(plugin): wire l3Llm/skillEvolver maxTokens+headers; raise dedicated-slot defaults to 4096"],
    ["d59fe83a", "fix(plugin): add l3Llm.maxTokens default (shares SkillEvolverSchema)"],
    ["70646de3", "fix(plugin): declare llm.maxTokens and llm.headers as first-class config keys"],
    ["1f28c8c5", "fix(config): apply OCR review to secret env resolver"],
    ["d38dfacb", "fix(config): resolve masked apiKey from env on load"],
    ["10cda282", "perf(plugin): batch idle skill archival"],
    ["0dad4af3", "fix(plugin): archive idle skills atomically"],
    ["02aa0d8b", "refactor(plugin): clarify Hermes regex variants"],
    ["d985d076", "refactor(plugin): avoid JS regex captures"],
    ["211dd165", "fix(plugin): harden Hermes pgrep pattern"],
    ["0ff0a72d", "fix(plugin): bound idle archive batches"],
    ["c5c0d0cd", "fix(plugin): address idle archive review"],
    ["411406dd", "fix(plugin): archive idle low-eta skills"],
    ["213665dd", "fix(memos-local-plugin): use POSIX-ERE-compatible pgrep pattern for hermes chat detection"],
    ["d76c78aa", "fix(plugin): resolve auxiliary reasoning capabilities"],
    ["b90b5c91", "fix(plugin): harden newest-trace index rollout"],
    ["f0f35c77", "fix(storage): add idx_traces_ts to unblock event loop on newest-first trace reads (#2284)"],
    ["068a701a", "fix(plugin): reconcile stale Hermes bridge status"],
    ["0d9503a1", "Fix #2255: memos_search returns Chinese text as unicode escapes (#2256)"],
    ["7b35fcd8", "fix(plugin): harden crystallizer draft recovery"],
    ["31976918", "test(plugin): format Hermes UTF-8 regression"],
    ["492bc844", "test(hermes-adapter): add world_model coverage and drop fragile \\u check"],
  ].map(([short_sha, subject]) => ({
    short_sha,
    sha: short_sha.padEnd(40, "0"),
    subject,
  }));

  const topics = releaseTopicsForCommits(commits);
  assert.ok(topics.length > 1);
  assert.ok(topics.length <= 15);
  assert.equal(releaseTopicLimitForRequiredCount(29), 15);
  assert.equal(
    topics.some((topic) =>
      topic.source_refs.some((ref) => ref === "31976918" || ref === "492bc844"),
    ),
    false,
    "the v2.0.18 test-only commits must not be required release-note evidence",
  );
  assert.equal(
    topics.flatMap((topic) => topic.source_refs).includes("#10786401"),
    false,
    "a numeric hexadecimal SHA must not be rewritten as a PR number",
  );
  assert.ok(topics.flatMap((topic) => topic.source_refs).includes("10786401"));

  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: topics.map((topic, index) => ({
        category: topic.category,
        text_cn: `**主题 ${index + 1}**：汇总同一用户影响下的本地插件改进。`,
        text_en: `**Topic ${index + 1}**: Groups related local-plugin changes by user impact.`,
        source_refs: [topic.source_refs.includes("10786401") ? "#10786401" : topic.source_refs[0]],
      })),
      coverage: {},
      warnings: [],
    },
    {
      commits,
      release_note_guidance: { release_topics: topics },
    },
  );

  assert.equal(processed.ok, true);
  assert.equal(processed.needs_review, false);
  assert.equal(processed.coverage.required_count, topics.length);
  assert.equal(processed.coverage.missing_required_count, 0);
  assert.equal(processed.postprocess.normalized_evidence_backed_source_refs, 1);
  assert.ok(processed.release_items.length > 0);
  assert.ok(
    processed.release_items.length <= topics.length,
    "topics with identical user impact may share one release-note item",
  );
  assert.deepEqual(
    new Set(processed.coverage.covered_refs),
    new Set(topics.flatMap((topic) => topic.source_refs)),
  );

  const omittedTopicRefs = new Set(topics[0].source_refs);
  const missingTopic = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: processed.release_items.map((item) => ({
        ...item,
        source_refs: item.source_refs.filter((ref) => !omittedTopicRefs.has(ref)),
      })),
      coverage: {},
      warnings: [],
    },
    {
      commits,
      release_note_guidance: { release_topics: topics },
    },
  );
  assert.equal(missingTopic.ok, false);
  assert.equal(missingTopic.needs_review, true);
  assert.equal(missingTopic.coverage.missing_required_count, 1);
});

test("compacts future topic growth below the hard item limit without losing evidence", () => {
  const topics = Array.from({ length: 40 }, (_, index) => ({
    key: `future-topic-${index}`,
    category: ["Added", "Improved", "Fixed"][index % 3],
    title_hint: `Future topic ${index}`,
    reason: "future release topic",
    source_refs: [`${(0xabc0000 + index).toString(16)}`],
    subjects: [`future local-plugin change ${index}`],
  }));

  const compacted = compactReleaseTopics(topics);
  assert.equal(releaseTopicLimitForRequiredCount(2), 12);
  assert.equal(releaseTopicLimitForRequiredCount(29), 15);
  assert.equal(releaseTopicLimitForRequiredCount(40), 18);
  assert.equal(compacted.length, 18);
  assert.equal(new Set(compacted.map((topic) => topic.key)).size, compacted.length);
  assert.deepEqual(
    new Set(compacted.flatMap((topic) => topic.source_refs)),
    new Set(topics.flatMap((topic) => topic.source_refs)),
  );
  assert.deepEqual(
    new Set(compacted.flatMap((topic) => topic.subjects)),
    new Set(topics.flatMap((topic) => topic.subjects)),
  );
  assert.ok(compacted.every((topic) => ["Added", "Improved", "Fixed"].includes(topic.category)));
});

test("repairs a numeric SHA that the draft formats as a PR reference", () => {
  const commit = {
    short_sha: "10786401",
    sha: "10786401abcdef0123456789abcdef0123456789",
    subject: "fix(plugin): stabilize memory recovery",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    title_hint: "Memory recovery",
    reason: "user-visible recovery fix",
    source_refs: [commit.short_sha],
    subjects: [commit.subject],
  };

  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Fixed",
          text_cn: "**记忆恢复**：修复异常数据恢复问题。",
          text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
          source_refs: ["#10786401"],
        },
      ],
      coverage: {},
      warnings: [],
    },
    {
      commits: [commit],
      release_note_guidance: { release_topics: [topic] },
    },
  );

  assert.equal(processed.ok, true);
  assert.equal(processed.needs_review, false);
  assert.deepEqual(processed.release_items[0].source_refs, ["10786401"]);
  assert.ok(Array.isArray(processed.coverage.invalid_item_refs));
  assert.equal(processed.coverage.invalid_item_refs.length, 0);
  assert.equal(processed.coverage.missing_required_count, 0);
  assert.equal(processed.postprocess.normalized_evidence_backed_source_refs, 1);
});

test("does not coerce a numeric PR-like prefix into an evidence SHA", () => {
  const commit = {
    short_sha: "12345678",
    sha: "12345678abcdef0123456789abcdef0123456789",
    subject: "fix(plugin): stabilize memory recovery",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    source_refs: [commit.short_sha],
    subjects: [commit.subject],
  };
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [{
        category: "Fixed",
        text_cn: "**记忆恢复**：修复异常数据恢复问题。",
        text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
        // This 7-digit prefix intentionally differs from the 8-character evidence SHA.
        source_refs: ["#1234567"],
      }],
      coverage: {},
    },
    { commits: [commit], release_note_guidance: { release_topics: [topic] } },
  );

  assert.equal(processed.ok, false);
  assert.equal(processed.coverage.invalid_item_refs.length, 1);
  assert.deepEqual(processed.postprocess.ambiguous_sha_refs, []);
  assert.deepEqual(processed.postprocess.unresolved_sha_refs, ["#1234567"]);
});

test("preserves an evidence-backed numeric PR reference", () => {
  const commit = {
    short_sha: "abcdef12",
    sha: "abcdef12".padEnd(40, "0"),
    subject: "fix(plugin): stabilize memory recovery (#10786401)",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    title_hint: "Memory recovery",
    reason: "user-visible recovery fix",
    source_refs: [commit.short_sha, "#10786401"],
    subjects: [commit.subject],
  };

  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Fixed",
          text_cn: "**记忆恢复**：修复异常数据恢复问题。",
          text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
          source_refs: ["#10786401"],
        },
      ],
      coverage: {},
      warnings: [],
    },
    {
      commits: [commit],
      release_note_guidance: { release_topics: [topic] },
    },
  );

  assert.equal(processed.ok, true);
  assert.equal(processed.needs_review, false);
  assert.deepEqual(
    [...processed.release_items[0].source_refs].sort(),
    ["#10786401", "abcdef12"].sort(),
  );
  assert.equal(processed.postprocess.normalized_evidence_backed_source_refs, 0);
});

test("normalizes explicit wrappers and a unique evidence-backed SHA prefix", () => {
  const commit = {
    short_sha: "10786401",
    sha: "10786401abcdef0123456789abcdef0123456789",
    subject: "fix(plugin): stabilize memory recovery",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    source_refs: [commit.short_sha],
    subjects: [commit.subject],
  };
  // This fixture has one commit, so the seven-character SHA prefix is unique. The
  // numeric and hexadecimal ambiguity tests below cover the multi-match rejection path.
  const variants = [
    "10786401",
    "#10786401",
    "# 10786401",
    "`#10786401`",
    "[10786401]",
    "(10786401)",
    "1078640",
    "commit 10786401",
    "commit: 1078640",
    "sha 10786401",
    "SHA: 10786401",
  ];

  for (const sourceRef of variants) {
    const processed = postprocessDraftFromEvidence(
      {
        ok: true,
        needs_review: false,
        release_items: [{
          category: "Fixed",
          text_cn: "**记忆恢复**：修复异常数据恢复问题。",
          text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
          source_refs: [sourceRef],
        }],
        coverage: {},
      },
      { commits: [commit], release_note_guidance: { release_topics: [topic] } },
    );
    assert.equal(processed.ok, true, sourceRef);
    assert.deepEqual(processed.release_items[0].source_refs, ["10786401"], sourceRef);
    assert.deepEqual(processed.postprocess.ambiguous_sha_refs, [], sourceRef);
    assert.deepEqual(processed.postprocess.unresolved_sha_refs, [], sourceRef);
  }
});

test("rejects a well-formed short SHA absent from collected evidence", () => {
  const commit = {
    short_sha: "abcdef12",
    sha: "abcdef12".padEnd(40, "0"),
    subject: "fix(plugin): stabilize memory recovery",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    source_refs: [commit.short_sha],
    subjects: [commit.subject],
  };
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [{
        category: "Fixed",
        text_cn: "**记忆恢复**：修复异常数据恢复问题。",
        text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
        source_refs: ["deadbeef"],
      }],
      coverage: {},
    },
    { commits: [commit], release_note_guidance: { release_topics: [topic] } },
  );

  assert.equal(processed.ok, false);
  assert.equal(processed.coverage.invalid_item_refs.length, 1);
  assert.deepEqual(processed.postprocess.unresolved_sha_refs, ["deadbeef"]);
  assert.match(processed.warnings.join("\n"), /did not resolve to collected evidence/);
});

test("does not count an unresolved wrapped SHA as evidence-backed normalization", () => {
  const commit = {
    short_sha: "abcdef12",
    sha: "abcdef12".padEnd(40, "0"),
    subject: "fix(plugin): stabilize memory recovery",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    source_refs: [commit.short_sha],
    subjects: [commit.subject],
  };
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [{
        category: "Fixed",
        text_cn: "**记忆恢复**：修复异常数据恢复问题。",
        text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
        source_refs: ["sha:deadbeef"],
      }],
      coverage: {},
    },
    { commits: [commit], release_note_guidance: { release_topics: [topic] } },
  );

  assert.equal(processed.ok, false);
  assert.equal(processed.postprocess.normalized_evidence_backed_source_refs, 0);
  assert.deepEqual(processed.postprocess.unresolved_sha_refs, ["sha:deadbeef"]);
  assert.deepEqual(processed.coverage.invalid_item_refs.map((item) => item.ref), ["deadbeef"]);
});

test("keeps explicit PR references strict instead of coercing them to numeric SHAs", () => {
  const commit = {
    short_sha: "10786401",
    sha: "10786401abcdef0123456789abcdef0123456789",
    subject: "fix(plugin): stabilize memory recovery (#10786401)",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    source_refs: [commit.short_sha],
    subjects: [commit.subject],
  };

  withGitHubRepository(evidence.repo, () => {
    for (const sourceRef of [
      "PR #10786401",
      "pull request: 10786401",
      "https://github.com/MemTensor/MemOS/pull/10786401",
    ]) {
      const processed = postprocessDraftFromEvidence(
        {
          ok: true,
          needs_review: false,
          release_items: [{
            category: "Fixed",
            text_cn: "**记忆恢复**：修复异常数据恢复问题。",
            text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
            source_refs: [sourceRef],
          }],
          coverage: {},
        },
        { commits: [commit], release_note_guidance: { release_topics: [topic] } },
      );
      assert.equal(processed.ok, false, sourceRef);
      assert.equal(processed.coverage.missing_required_count, 1, sourceRef);
      assert.equal(processed.coverage.invalid_item_refs.length, 0, sourceRef);
    }
  });
});

test("accepts an evidence PR URL and retains its linked commit alias", () => {
  const commit = {
    short_sha: "abcdef12",
    sha: "abcdef12".padEnd(40, "0"),
    subject: "fix(plugin): stabilize memory recovery (#10786401)",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    source_refs: [commit.short_sha, "#10786401"],
    subjects: [commit.subject],
  };
  const processed = withGitHubRepository(evidence.repo, () => postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [{
        category: "Fixed",
        text_cn: "**记忆恢复**：修复异常数据恢复问题。",
        text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
        source_refs: ["https://github.com/MemTensor/MemOS/pull/10786401"],
      }],
      coverage: {},
    },
    { commits: [commit], release_note_guidance: { release_topics: [topic] } },
  ));

  assert.equal(processed.ok, true);
  // The URL is replaced, not retained alongside the canonical evidence aliases.
  assert.deepEqual(
    [...processed.release_items[0].source_refs].sort(),
    ["#10786401", "abcdef12"].sort(),
  );
});

test("rejects source URLs from repositories outside MemTensor/MemOS", () => {
  const commit = {
    short_sha: "abcdef12",
    sha: "abcdef12".padEnd(40, "0"),
    subject: "fix(plugin): stabilize memory recovery (#1234)",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    source_refs: [commit.short_sha, "#1234"],
    subjects: [commit.subject],
  };

  withGitHubRepository(evidence.repo, () => {
    for (const sourceRef of [
      `https://github.com/another/repository/commit/${commit.sha}`,
      "https://github.com/another/repository/pull/1234",
    ]) {
      const processed = postprocessDraftFromEvidence(
        {
          ok: true,
          needs_review: false,
          release_items: [{
            category: "Fixed",
            text_cn: "**记忆恢复**：修复异常数据恢复问题。",
            text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
            source_refs: [sourceRef],
          }],
          coverage: {},
        },
        { commits: [commit], release_note_guidance: { release_topics: [topic] } },
      );
      assert.equal(processed.ok, false, sourceRef);
      assert.equal(processed.postprocess.dropped_invalid_items, 1, sourceRef);
    }
  });
});

test("uses GITHUB_REPOSITORY as the source URL trust boundary", () => {
  const previousRepository = process.env.GITHUB_REPOSITORY;
  const commit = {
    short_sha: "abcdef12",
    sha: "abcdef12".padEnd(40, "0"),
    subject: "fix(plugin): stabilize memory recovery (#1234)",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    source_refs: [commit.short_sha, "#1234"],
    subjects: [commit.subject],
  };
  try {
    process.env.GITHUB_REPOSITORY = "ForkOwner/ForkRepo";
    const processed = postprocessDraftFromEvidence(
      {
        ok: true,
        needs_review: false,
        release_items: [{
          category: "Fixed",
          text_cn: "**记忆恢复**：修复异常数据恢复问题。",
          text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
          source_refs: [`https://github.com/ForkOwner/ForkRepo/commit/${commit.sha}`],
        }],
        coverage: {},
      },
      { commits: [commit], release_note_guidance: { release_topics: [topic] } },
    );
    assert.equal(processed.ok, true);
    assert.deepEqual(
      [...processed.release_items[0].source_refs].sort(),
      [commit.short_sha, "#1234"].sort(),
    );

    const acceptedPull = postprocessDraftFromEvidence(
      {
        ok: true,
        needs_review: false,
        release_items: [{
          category: "Fixed",
          text_cn: "**记忆恢复**：修复异常数据恢复问题。",
          text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
          source_refs: ["https://github.com/ForkOwner/ForkRepo/pull/1234"],
        }],
        coverage: {},
      },
      { commits: [commit], release_note_guidance: { release_topics: [topic] } },
    );
    assert.equal(acceptedPull.ok, true);
    assert.deepEqual(
      [...acceptedPull.release_items[0].source_refs].sort(),
      [commit.short_sha, "#1234"].sort(),
    );

    const rejected = postprocessDraftFromEvidence(
      {
        ok: true,
        needs_review: false,
        release_items: [{
          category: "Fixed",
          text_cn: "**记忆恢复**：修复异常数据恢复问题。",
          text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
          source_refs: [`https://github.com/MemTensor/MemOS/commit/${commit.sha}`],
        }],
        coverage: {},
      },
      { commits: [commit], release_note_guidance: { release_topics: [topic] } },
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.postprocess.dropped_invalid_items, 1);

    const rejectedPull = postprocessDraftFromEvidence(
      {
        ok: true,
        needs_review: false,
        release_items: [{
          category: "Fixed",
          text_cn: "**记忆恢复**：修复异常数据恢复问题。",
          text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
          source_refs: ["https://github.com/MemTensor/MemOS/pull/1234"],
        }],
        coverage: {},
      },
      { commits: [commit], release_note_guidance: { release_topics: [topic] } },
    );
    assert.equal(rejectedPull.ok, false);
    assert.equal(rejectedPull.postprocess.dropped_invalid_items, 1);
  } finally {
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
  }
});

test("fails closed for repository URLs when GITHUB_REPOSITORY is unavailable", () => {
  const previousRepository = process.env.GITHUB_REPOSITORY;
  const commit = {
    short_sha: "abcdef12",
    sha: "abcdef12".padEnd(40, "0"),
    subject: "fix(plugin): stabilize memory recovery",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    source_refs: [commit.short_sha],
    subjects: [commit.subject],
  };
  try {
    delete process.env.GITHUB_REPOSITORY;
    const processed = postprocessDraftFromEvidence(
      {
        ok: true,
        needs_review: false,
        release_items: [{
          category: "Fixed",
          text_cn: "**记忆恢复**：修复异常数据恢复问题。",
          text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
          source_refs: [`https://github.com/MemTensor/MemOS/commit/${commit.sha}`],
        }],
        coverage: {},
      },
      { commits: [commit], release_note_guidance: { release_topics: [topic] } },
    );
    assert.equal(processed.ok, false);
    assert.equal(processed.postprocess.dropped_invalid_items, 1);
  } finally {
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
  }
});

test("keeps ambiguous SHA prefixes fail-closed", () => {
  const commits = [
    { short_sha: "1078640a", sha: "1078640a".padEnd(40, "0"), subject: "fix(plugin): recovery A" },
    { short_sha: "1078640b", sha: "1078640b".padEnd(40, "0"), subject: "fix(plugin): recovery B" },
  ];
  const topics = commits.map((commit, index) => ({
    key: `recovery-${index}`,
    category: "Fixed",
    source_refs: [commit.short_sha],
    subjects: [commit.subject],
  }));
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [{
        category: "Fixed",
        text_cn: "**记忆恢复**：修复异常数据恢复问题。",
        text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
        source_refs: ["1078640"],
      }],
      coverage: {},
    },
    { commits, release_note_guidance: { release_topics: topics } },
  );

  assert.equal(processed.ok, false);
  assert.equal(processed.needs_review, true);
  assert.equal(processed.coverage.invalid_item_refs.length, 1);
  assert.equal(processed.coverage.missing_required_count, 2);
  assert.deepEqual(processed.postprocess.ambiguous_sha_refs, ["1078640"]);
  assert.match(processed.warnings.join("\n"), /ambiguous SHA source_refs/);
});

test("deduplicates repeated evidence commits before resolving SHA prefixes", () => {
  const commit = {
    short_sha: "abcdef12",
    sha: "abcdef12".padEnd(40, "0"),
    subject: "fix(plugin): stabilize memory recovery",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    source_refs: [commit.short_sha],
    subjects: [commit.subject],
  };
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [{
        category: "Fixed",
        text_cn: "**记忆恢复**：修复异常数据恢复问题。",
        text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
        source_refs: ["abcdef1"],
      }],
      coverage: {},
    },
    { commits: [commit, { ...commit }], release_note_guidance: { release_topics: [topic] } },
  );

  assert.equal(processed.ok, true);
  assert.deepEqual(processed.release_items[0].source_refs, [commit.short_sha]);
  assert.deepEqual(processed.postprocess.ambiguous_sha_refs, []);
  assert.deepEqual(processed.postprocess.unresolved_sha_refs, []);
});

test("initializes warnings when a valid draft omits the field", () => {
  const commit = {
    short_sha: "abcdef12",
    sha: "abcdef12".padEnd(40, "0"),
    subject: "fix(plugin): stabilize memory recovery",
  };
  const topic = {
    key: "memory-recovery",
    category: "Fixed",
    source_refs: [commit.short_sha],
    subjects: [commit.subject],
  };
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [{
        category: "Fixed",
        text_cn: "**记忆恢复**：修复异常数据恢复问题。",
        text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
        source_refs: [commit.short_sha],
      }],
      coverage: {},
    },
    { commits: [commit], release_note_guidance: { release_topics: [topic] } },
  );

  assert.equal(processed.ok, true);
  assert.deepEqual(processed.warnings, []);
});

test("keeps ambiguous hexadecimal SHA prefixes fail-closed", () => {
  const commits = [
    { short_sha: "abcdef1a", sha: "abcdef1a".padEnd(40, "0"), subject: "fix(plugin): recovery A" },
    { short_sha: "abcdef1b", sha: "abcdef1b".padEnd(40, "0"), subject: "fix(plugin): recovery B" },
  ];
  const topics = commits.map((commit, index) => ({
    key: `recovery-${index}`,
    category: "Fixed",
    source_refs: [commit.short_sha],
    subjects: [commit.subject],
  }));
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [{
        category: "Fixed",
        text_cn: "**记忆恢复**：修复异常数据恢复问题。",
        text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
        source_refs: ["abcdef1"],
      }],
      coverage: {},
    },
    { commits, release_note_guidance: { release_topics: topics } },
  );

  assert.equal(processed.ok, false);
  assert.equal(processed.needs_review, true);
  assert.equal(processed.coverage.invalid_item_refs.length, 1);
  assert.equal(processed.coverage.missing_required_count, 2);
  assert.deepEqual(processed.postprocess.ambiguous_sha_refs, ["abcdef1"]);
  assert.match(processed.warnings.join("\n"), /ambiguous SHA source_refs/);
});

test("fails closed when every draft item is malformed", () => {
  const commit = {
    short_sha: "abcdef12",
    sha: "abcdef12".padEnd(40, "0"),
    subject: "fix(plugin): stabilize memory recovery",
  };
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [{
        category: "Fixed",
        text_cn: "**记忆恢复**：修复异常数据恢复问题。",
        text_en: "**Memory Recovery**: Fixed abnormal data recovery.",
        source_refs: ["not-a-source-ref"],
      }],
      coverage: {},
    },
    {
      commits: [commit],
      release_note_guidance: {
        release_topics: [{
          key: "memory-recovery",
          category: "Fixed",
          source_refs: [commit.short_sha],
          subjects: [commit.subject],
        }],
      },
    },
  );

  assert.equal(processed.ok, false);
  assert.equal(processed.needs_review, true);
  assert.deepEqual(processed.release_items, []);
  assert.equal(processed.coverage.missing_required_count, 1);
  assert.equal(processed.postprocess.dropped_invalid_items, 1);
  // Structurally invalid items are dropped before evidence coverage checks.
  assert.equal(processed.coverage.invalid_item_refs.length, 0);
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

test("keeps release-note quality issues in the inspection draft", () => {
  const inspection = draftForInspection({
    ok: false,
    needs_review: true,
    coverage: {
      needs_review: true,
      required_count: 16,
      covered_required_count: 16,
      quality_issues: ["too many release items: 16 > 12"],
      items_missing_source_refs: [],
    },
  });

  assert.deepEqual(inspection.coverage.quality_issues, ["too many release items: 16 > 12"]);
  assert.deepEqual(inspection.coverage.items_missing_source_refs, []);
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

test("standalone latest draft validation allows one initial response plus three repairs by default", async () => {
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
  const badDraft = {
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
  const goodDraft = {
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
  let calls = 0;
  const requestImpl = async () => {
    calls += 1;
    return calls < 4 ? badDraft : goodDraft;
  };

  const result = await requestValidatedDraft(repairEvidence, { requestImpl });

  assert.equal(calls, 4);
  assert.equal(result.ok, true);
  assert.equal(result.needs_review, false);
  assert.equal(result.validation_attempt_count, 4);
  assert.equal(result.repair_attempt_count, 3);
  assert.match(result.release_notes_markdown, /插件健康看板/);
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
  {"items":[{"category":"Added","text_cn":"Local memory","text_en":"本地记忆","source_refs":["abc1234"]}],"coverage":{"needs_review":false}}
-->`),
    /text_cn must contain Chinese/,
  );
});

test("manual stable notes are revalidated against collected evidence", () => {
  const notes = `## Changelog

### Fixed
- 修复 Hermes 桥接状态恢复。

<!-- doc-agent-release-notes-json
{"items":[{"category":"Fixed","text_cn":"修复 Hermes 桥接状态恢复。","text_en":"Restores Hermes bridge state.","source_refs":["abc1234"]}],"coverage":{"needs_review":false}}
-->`;
  const evidence = {
    commits: [{
      sha: "abc1234567890abc1234567890abc1234567890",
      short_sha: "abc1234",
      subject: "fix: restore Hermes bridge state",
    }],
    important_commits: [{
      sha: "abc1234567890abc1234567890abc1234567890",
      short_sha: "abc1234",
      subject: "fix: restore Hermes bridge state",
    }],
    release_note_guidance: {
      source_ref_category_hints: [{ source_refs: ["abc1234"], category: "Fixed" }],
    },
  };
  const draft = manualDraftFromNotes(notes, evidence);
  assert.equal(draft.ok, true);
  assert.equal(draft.release_items[0].category, "Fixed");
  assert.match(draft.release_notes_markdown, /source-id=openclaw-local-plugin/);

  assert.throws(
    () => manualDraftFromNotes(notes.replaceAll("abc1234", "deadbee"), evidence),
    /failed evidence validation/,
  );
});

test("legacy package manual notes reject docs payloads", () => {
  const valid = `## Changelog

### Prerelease
- Published MemOS Local Plugin v2.0.13-beta.1 as a beta package.`;
  assert.equal(validateLegacyPackageNotes(valid), `${valid}\n`);
  assert.throws(
    () => validateLegacyPackageNotes(`${valid}\n\n<!-- doc-agent: source-id=openclaw-local-plugin -->`),
    /must not include Doc Agent source hints/,
  );
  assert.throws(
    () => validateLegacyPackageNotes(`${valid}\n\n<!-- doc-agent-release-notes-json\n{}\n-->`),
    /must not include Doc Agent source hints/,
  );
  assert.throws(() => validateLegacyPackageNotes("### Prerelease\n- missing changelog"), /Changelog/);
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

test("reports compact quality details and preserves the rejected draft for diagnostics", async () => {
  const previous = { ...process.env };
  try {
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = "https://example.invalid/draft";
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    const payload = {
      ok: false,
      needs_review: true,
      release_items: Array.from({ length: 16 }, (_, index) => ({
        category: "Fixed",
        text_cn: `修复条目 ${index + 1}`,
        text_en: `Fix item ${index + 1}`,
        source_refs: [`abc${String(index).padStart(4, "0")}`],
      })),
      coverage: {
        needs_review: true,
        required_count: 16,
        covered_required_count: 16,
        missing_required_count: 0,
        invalid_item_refs: [],
        items_missing_source_refs: [],
        quality_issues: ["too many release items: 16 > 12"],
      },
      warnings: ["too many release items: 16 > 12"],
      attempts: [],
    };

    await assert.rejects(
      requestDraft(evidence, {
        fetchImpl: async () => response(200, payload),
        sleep: async () => {},
      }),
      (error) => {
        assert.match(error.message, /too many release items: 16 > 12/);
        assert.deepEqual(error.draftPayload, payload);
        return true;
      },
    );
  } finally {
    process.env = previous;
  }
});

test("writes a redacted failure artifact without endpoint or token details", () => {
  const previous = { ...process.env };
  const directory = mkdtempSync(join(tmpdir(), "local-plugin-draft-failure-"));
  try {
    process.env.RELEASE_NOTES_FAILURE_DIR = directory;
    writeDraftFailureInspection({
      evidence: {
        ...evidence,
        important_diff: { "apps/memos-local-plugin/**": "private diff" },
      },
      payload: {
        ok: false,
        needs_review: true,
        coverage: {
          required_count: 16,
          covered_required_count: 16,
          quality_issues: ["too many release items: 16 > 12"],
        },
      },
      error: new Error("failed at https://private.example/draft with Bearer secret-token"),
    });

    const report = readFileSync(join(directory, "quality-report.json"), "utf8");
    const redactedEvidence = readFileSync(join(directory, "evidence.json"), "utf8");
    assert.match(report, /too many release items: 16 > 12/);
    assert.doesNotMatch(report, /private\.example|secret-token/);
    assert.doesNotMatch(redactedEvidence, /private diff/);
  } finally {
    process.env = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("writes failure diagnostics when final postprocessing remains invalid", () => {
  const previousFailureDir = process.env.RELEASE_NOTES_FAILURE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "local-plugin-postprocess-failure-"));
  try {
    process.env.RELEASE_NOTES_FAILURE_DIR = directory;
    const invalidDraft = {
      ok: false,
      needs_review: true,
      release_items: [{
        category: "Fixed",
        text_cn: "修复记忆恢复问题。",
        text_en: "Fixed memory recovery.",
        source_refs: ["#10786401"],
      }],
      coverage: {
        needs_review: true,
        required_count: 1,
        covered_required_count: 1,
        missing_required_count: 0,
        invalid_item_refs: [{ ref: "#10786401" }],
      },
      validation_report: {
        ok: false,
        needs_review: true,
        invalid_item_ref_count: 1,
      },
    };

    assert.throws(
      () => requireValidatedDraft({ evidence, draft: invalidDraft }),
      /Postprocessed release notes require review/,
    );
    const report = JSON.parse(readFileSync(join(directory, "quality-report.json"), "utf8"));
    assert.equal(report.ok, false);
    assert.equal(report.invalid_item_ref_count, 1);
    const diagnosticDraft = JSON.parse(
      readFileSync(join(directory, "release-notes-draft.json"), "utf8"),
    );
    assert.deepEqual(diagnosticDraft.release_items[0].source_refs, ["#10786401"]);
  } finally {
    if (previousFailureDir === undefined) delete process.env.RELEASE_NOTES_FAILURE_DIR;
    else process.env.RELEASE_NOTES_FAILURE_DIR = previousFailureDir;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("returns a fully validated draft without writing failure diagnostics", () => {
  const previousFailureDir = process.env.RELEASE_NOTES_FAILURE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "local-plugin-valid-draft-"));
  try {
    process.env.RELEASE_NOTES_FAILURE_DIR = directory;
    const validDraft = { ok: true, needs_review: false, release_items: [] };
    assert.strictEqual(requireValidatedDraft({ evidence, draft: validDraft }), validDraft);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    if (previousFailureDir === undefined) delete process.env.RELEASE_NOTES_FAILURE_DIR;
    else process.env.RELEASE_NOTES_FAILURE_DIR = previousFailureDir;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects ok drafts that still require review", () => {
  const previousFailureDir = process.env.RELEASE_NOTES_FAILURE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "local-plugin-needs-review-"));
  try {
    process.env.RELEASE_NOTES_FAILURE_DIR = directory;
    assert.throws(
      () => requireValidatedDraft({
        evidence,
        draft: { ok: true, needs_review: true, release_items: [] },
      }),
      /Postprocessed release notes require review/,
    );
    assert.deepEqual(
      readdirSync(directory).sort(),
      ["README.md", "evidence.json", "quality-report.json", "release-notes-draft.json"],
    );
  } finally {
    if (previousFailureDir === undefined) delete process.env.RELEASE_NOTES_FAILURE_DIR;
    else process.env.RELEASE_NOTES_FAILURE_DIR = previousFailureDir;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves the validation error when failure diagnostics cannot be written", () => {
  const previousFailureDir = process.env.RELEASE_NOTES_FAILURE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "local-plugin-unwritable-diagnostics-"));
  const filePath = join(directory, "not-a-directory");
  try {
    writeFileSync(filePath, "blocks directory creation", "utf8");
    process.env.RELEASE_NOTES_FAILURE_DIR = filePath;
    assert.throws(
      () => requireValidatedDraft({ evidence, draft: { ok: false, needs_review: true } }),
      /Postprocessed release notes require review/,
    );
  } finally {
    if (previousFailureDir === undefined) delete process.env.RELEASE_NOTES_FAILURE_DIR;
    else process.env.RELEASE_NOTES_FAILURE_DIR = previousFailureDir;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves the validation error when its summary is not serializable", () => {
  const coverage = { needs_review: true };
  coverage.circular = coverage;
  assert.throws(
    () => requireValidatedDraft({ evidence, draft: { ok: false, needs_review: true, coverage } }),
    /Postprocessed release notes require review:.*summary_unavailable/,
  );
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
