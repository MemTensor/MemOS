import assert from "node:assert/strict";
import test from "node:test";

import { buildFormalSyncRequest, validateFormalDraft } from "./prepare-local-plugin-formal-sync.mjs";

const sha = "a".repeat(40);
const evidence = {
  product_id: "openclaw-local-plugin",
  repo: "MemTensor/MemOS",
  target_version: "v2.0.14",
  current_tag: "memos-local-plugin-v2.0.14",
  git_ref: sha.slice(0, 12),
  commits: [{ sha, short_sha: sha.slice(0, 8), source_refs: [sha.slice(0, 8), sha, "#123"] }],
  pull_requests: [{ number: "123" }],
  required_source_refs: [{ short_sha: sha.slice(0, 8), accepted_refs: [sha.slice(0, 8), sha, "#123"] }],
};
const draft = {
  ok: true,
  needs_review: false,
  release_items: [{
    category: "Fixed",
    text_cn: "**桥接恢复**：修复重启后的配置恢复流程。",
    text_en: "**Bridge recovery**: Fixed configuration recovery after restart.",
    source_refs: ["#123"],
  }],
  coverage: { needs_review: false, missing_required_count: 0 },
};

test("builds an evidence-bound stable formal sync request", () => {
  const payload = buildFormalSyncRequest({
    version: "2.0.14",
    tag: "memos-local-plugin-v2.0.14",
    sourceSha: sha,
    evidence,
    draft,
    publishedAt: "2026-08-04T00:00:00Z",
  });
  assert.equal(payload.version, "v2.0.14");
  assert.match(payload.evidence_digest, /^[0-9a-f]{64}$/);
  assert.match(payload.idempotency_key, /memos-local-plugin-v2\.0\.14/);
});

test("rejects prerelease formal sync and evidence-free bullets", () => {
  assert.throws(
    () => buildFormalSyncRequest({
      version: "2.0.14-beta.1",
      tag: "memos-local-plugin-v2.0.14-beta.1",
      sourceSha: sha,
      evidence,
      draft,
    }),
    /stable SemVer/,
  );
  assert.throws(
    () => validateFormalDraft(evidence, {
      ...draft,
      release_items: [{ ...draft.release_items[0], source_refs: ["not-real"] }],
    }),
    /unknown source_ref/,
  );
});

test("rejects uncovered important evidence and mixed-language English", () => {
  assert.throws(
    () => validateFormalDraft(evidence, {
      ...draft,
      release_items: [{
        ...draft.release_items[0],
        text_en: "Fixed 桥接 recovery.",
        source_refs: [],
      }],
    }),
    /invalid English text/,
  );
});

test("rejects evidence copied from another version, tag, repository, or source", () => {
  for (const invalidEvidence of [
    { ...evidence, repo: "someone/else" },
    { ...evidence, target_version: "v2.0.13" },
    { ...evidence, current_tag: "memos-local-plugin-v2.0.13" },
    { ...evidence, git_ref: "not-a-sha" },
  ]) {
    assert.throws(
      () => buildFormalSyncRequest({
        version: "2.0.14",
        tag: "memos-local-plugin-v2.0.14",
        sourceSha: sha,
        evidence: invalidEvidence,
        draft,
        publishedAt: "2026-08-04T00:00:00Z",
      }),
      /evidence/,
    );
  }
});
