import assert from "node:assert/strict";
import test from "node:test";

import {
  INTENT_SCHEMA,
  appendIntentToReleaseNotes,
  buildLocalPluginReleaseIntent,
  parseLocalPluginReleaseIntent,
} from "./append-local-plugin-release-intent.mjs";

const digest = "a".repeat(64);

test("disabled intent contains no guessed version or source SHA", () => {
  assert.deepEqual(
    buildLocalPluginReleaseIntent({
      enabled: false,
      evidenceDigest: digest,
      memosReleaseTag: "v2.0.28",
    }),
    {
      schema: INTENT_SCHEMA,
      enabled: false,
      memos_release_tag: "v2.0.28",
      paired_release: false,
      version: "",
      tag: "",
      source_sha: "",
      evidence_digest: digest,
      plugin_release_url: "",
      docs_trigger: "none",
    },
  );
});

test("enabled intent binds version, immutable tag, source SHA, and evidence", () => {
  const intent = buildLocalPluginReleaseIntent({
    enabled: true,
    version: "2.0.14",
    tag: "memos-local-plugin-v2.0.14",
    sourceSha: "b".repeat(40),
    evidenceDigest: digest,
    memosReleaseTag: "v2.0.28",
    pluginReleaseUrl: "https://github.com/MemTensor/MemOS/releases/tag/memos-local-plugin-v2.0.14",
  });
  assert.equal(intent.version, "v2.0.14");
  assert.equal(intent.source_sha, "b".repeat(40));
  const notes = appendIntentToReleaseNotes("## What's Changed\n", intent);
  assert.match(notes, /doc-agent-local-plugin-release-intent/);
  assert.deepEqual(parseLocalPluginReleaseIntent(notes), intent);
});

test("enabled intent fails closed for mismatched tags and prereleases", () => {
  assert.throws(
    () => buildLocalPluginReleaseIntent({
      enabled: true,
      version: "2.0.14",
      tag: "memos-local-plugin-v2.0.15",
      sourceSha: "b".repeat(40),
      evidenceDigest: digest,
      memosReleaseTag: "v2.0.28",
      pluginReleaseUrl: "https://github.com/MemTensor/MemOS/releases/tag/memos-local-plugin-v2.0.15",
    }),
    /must equal/,
  );
  assert.throws(
    () => buildLocalPluginReleaseIntent({
      enabled: true,
      version: "2.0.14-beta.1",
      tag: "memos-local-plugin-v2.0.14-beta.1",
      sourceSha: "b".repeat(40),
      evidenceDigest: digest,
      memosReleaseTag: "v2.0.28",
      pluginReleaseUrl: "https://github.com/MemTensor/MemOS/releases/tag/memos-local-plugin-v2.0.14-beta.1",
    }),
    /stable SemVer/,
  );
});

test("release notes refuse duplicate intent markers", () => {
  assert.throws(
    () => appendIntentToReleaseNotes("## Notes\n<!-- doc-agent-local-plugin-release-intent\n{}\n-->", {}),
    /already contain/,
  );
});
