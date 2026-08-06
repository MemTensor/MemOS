import assert from "node:assert/strict";
import test from "node:test";

import { appendIntentToReleaseNotes, buildLocalPluginReleaseIntent } from "./append-local-plugin-release-intent.mjs";
import { appendLocalPluginReleaseBinding, buildLocalPluginReleaseBinding } from "./local-plugin-release-contract.mjs";
import { validatePair } from "./publish-paired-local-plugin-release.mjs";

const digest = "d".repeat(64);
const sourceSha = "a".repeat(40);
const memosTagSha = "c".repeat(40);
const pairArgs = {
  pluginTagSha: sourceSha,
  pluginTagParentShas: [memosTagSha],
  memosTagSha,
};
const intent = buildLocalPluginReleaseIntent({
  enabled: true,
  version: "2.0.14",
  tag: "memos-local-plugin-v2.0.14",
  sourceSha,
  evidenceDigest: digest,
  memosReleaseTag: "v2.0.28",
  pluginReleaseUrl: "https://github.com/MemTensor/MemOS/releases/tag/memos-local-plugin-v2.0.14",
});
const binding = buildLocalPluginReleaseBinding({
  version: "2.0.14",
  tag: intent.tag,
  sourceSha,
  evidenceDigest: digest,
  originMode: "memos_weekly",
  memosReleaseTag: "v2.0.28",
});
const memosRelease = {
  tag: "v2.0.28",
  body: appendIntentToReleaseNotes("## What's Changed", intent),
  draft: false,
  prerelease: false,
  publishedAt: "2026-08-04T08:00:00Z",
};
const pluginRelease = {
  id: 42,
  tag: intent.tag,
  name: "MemOS Local Plugin v2.0.14",
  body: appendLocalPluginReleaseBinding("## Changelog", binding),
  draft: true,
  prerelease: false,
  url: intent.plugin_release_url,
};

test("paired publisher accepts exactly matching draft contracts", () => {
  const result = validatePair({ memosRelease, pluginRelease, ...pairArgs });
  assert.equal(result.enabled, true);
  assert.equal(result.alreadyPublished, false);
});

test("paired publisher treats a matching published plugin Release as idempotent success", () => {
  const result = validatePair({
    memosRelease,
    pluginRelease: {
      ...pluginRelease,
      draft: false,
      publishedAt: "2026-08-04T08:00:01Z",
    },
    ...pairArgs,
  });
  assert.equal(result.alreadyPublished, true);
});

test("paired publisher rejects a plugin Release published before the MemOS Release", () => {
  assert.throws(
    () => validatePair({
      memosRelease,
      pluginRelease: {
        ...pluginRelease,
        draft: false,
        publishedAt: "2026-08-04T07:59:59Z",
      },
      ...pairArgs,
    }),
    /published before its paired MemOS Release/,
  );
});

test("paired publisher fails closed for wrong source, digest, or main tag", () => {
  assert.throws(
    () => validatePair({
      memosRelease,
      pluginRelease,
      ...pairArgs,
      pluginTagSha: "b".repeat(40),
    }),
    /points to/,
  );
  const wrongBinding = { ...binding, evidence_digest: "e".repeat(64) };
  assert.throws(
    () => validatePair({
      memosRelease,
      pluginRelease: {
        ...pluginRelease,
        body: appendLocalPluginReleaseBinding("## Changelog", wrongBinding),
      },
      ...pairArgs,
    }),
    /does not match/,
  );
  assert.throws(
    () => validatePair({
      memosRelease: { ...memosRelease, tag: "v2.0.29" },
      pluginRelease,
      ...pairArgs,
    }),
    /bound to v2\.0\.28/,
  );
});

test("paired publisher rejects a plugin tag from unrelated MemOS source", () => {
  assert.throws(
    () => validatePair({
      memosRelease,
      pluginRelease,
      pluginTagSha: sourceSha,
      pluginTagParentShas: ["e".repeat(40)],
      memosTagSha,
    }),
    /is not based on MemOS Release/,
  );
});

test("disabled intent is a successful no-op", () => {
  const disabled = buildLocalPluginReleaseIntent({
    enabled: false,
    evidenceDigest: digest,
    memosReleaseTag: "v2.0.28",
  });
  const result = validatePair({
    memosRelease: {
      tag: "v2.0.28",
      body: appendIntentToReleaseNotes("## What's Changed", disabled),
      draft: false,
      prerelease: false,
      publishedAt: "2026-08-04T08:00:00Z",
    },
    pluginRelease: null,
    pluginTagSha: "",
  });
  assert.equal(result.enabled, false);
});
