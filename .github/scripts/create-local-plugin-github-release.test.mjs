import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleaseContract,
  validateRelease,
} from "./create-local-plugin-github-release.mjs";

test("release contract derives one canonical digest for body and pairing metadata", () => {
  const evidence = {
    product_id: "openclaw-local-plugin",
    commits: [{ sha: "a".repeat(40), source_refs: ["a".repeat(8)] }],
  };
  const contract = buildReleaseContract({
    version: "2.0.14",
    tag: "memos-local-plugin-v2.0.14",
    tagSha: "b".repeat(40),
    notes: "## Changelog\n\n### Fixed\n- Restored bridge state.",
    evidence,
    originMode: "memos_weekly",
    memosReleaseTag: "v2.0.28",
    createDraft: true,
  });
  assert.equal(contract.binding.evidence_digest, contract.evidenceDigest);
  assert.equal(contract.createDraft, true);
  assert.match(contract.body, /doc-agent-local-plugin-release-binding/);
  assert.match(contract.body, /local_plugin_release_published/);
});

test("release contract rejects a digest supplied by a different evidence snapshot", () => {
  assert.throws(
    () => buildReleaseContract({
      version: "2.0.14",
      tag: "memos-local-plugin-v2.0.14",
      tagSha: "b".repeat(40),
      notes: "## Changelog",
      evidence: { commits: [] },
      expectedEvidenceDigest: "c".repeat(64),
      originMode: "memos_weekly",
      memosReleaseTag: "v2.0.28",
      createDraft: true,
    }),
    /evidence digest mismatch/,
  );
});

test("weekly Draft creation rejects a plugin Release published before the MemOS Release", () => {
  const contract = buildReleaseContract({
    version: "2.0.14",
    tag: "memos-local-plugin-v2.0.14",
    tagSha: "b".repeat(40),
    notes: "## Changelog\n\n### Fixed\n- Restored bridge state.",
    evidence: { commits: [{ sha: "a".repeat(40) }] },
    originMode: "memos_weekly",
    memosReleaseTag: "v2.0.28",
    createDraft: true,
  });
  const release = {
    tagName: contract.binding.tag,
    name: `MemOS Local Plugin ${contract.binding.version}`,
    body: contract.body,
    isDraft: false,
    isPrerelease: false,
    isLatest: false,
    url: "https://github.com/MemTensor/MemOS/releases/tag/memos-local-plugin-v2.0.14",
  };
  assert.throws(
    () => validateRelease(release, contract),
    /published before its paired MemOS Release/,
  );
});

test("standalone reruns accept an exactly matching already-published Release", () => {
  const contract = buildReleaseContract({
    version: "2.0.14",
    tag: "memos-local-plugin-v2.0.14",
    tagSha: "b".repeat(40),
    notes: "## Changelog\n\n### Fixed\n- Restored bridge state.",
    evidence: { commits: [{ sha: "a".repeat(40) }] },
    originMode: "standalone",
    createDraft: false,
  });
  const release = {
    tagName: contract.binding.tag,
    name: `MemOS Local Plugin ${contract.binding.version}`,
    body: contract.body,
    isDraft: false,
    isPrerelease: false,
    isLatest: false,
    url: "https://github.com/MemTensor/MemOS/releases/tag/memos-local-plugin-v2.0.14",
  };
  assert.deepEqual(validateRelease(release, contract), {
    alreadyPublished: true,
    url: release.url,
  });
});
