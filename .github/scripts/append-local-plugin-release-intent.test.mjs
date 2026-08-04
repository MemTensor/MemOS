import assert from "node:assert/strict";
import test from "node:test";

import {
  INTENT_SCHEMA,
  appendIntentToReleaseNotes,
  buildLocalPluginReleaseIntent,
} from "./append-local-plugin-release-intent.mjs";

const digest = "a".repeat(64);

test("disabled intent contains no guessed version or source SHA", () => {
  assert.deepEqual(
    buildLocalPluginReleaseIntent({ enabled: false, evidenceDigest: digest }),
    {
      schema: INTENT_SCHEMA,
      enabled: false,
      version: "",
      tag: "",
      source_sha: "",
      evidence_digest: digest,
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
  });
  assert.equal(intent.version, "v2.0.14");
  assert.equal(intent.source_sha, "b".repeat(40));
  assert.match(appendIntentToReleaseNotes("## What's Changed\n", intent), /doc-agent-local-plugin-release-intent/);
});

test("enabled intent fails closed for mismatched tags and prereleases", () => {
  assert.throws(
    () => buildLocalPluginReleaseIntent({
      enabled: true,
      version: "2.0.14",
      tag: "memos-local-plugin-v2.0.15",
      sourceSha: "b".repeat(40),
      evidenceDigest: digest,
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
