import assert from "node:assert/strict";
import test from "node:test";

import {
  appendLocalPluginReleaseBinding,
  buildLocalPluginReleaseBinding,
  parseLocalPluginReleaseBinding,
  sha256Json,
  validateExistingLocalPluginRelease,
} from "./local-plugin-release-contract.mjs";

const digest = sha256Json({ commits: [{ sha: "a".repeat(40) }] });
const weekly = buildLocalPluginReleaseBinding({
  version: "2.0.14",
  tag: "memos-local-plugin-v2.0.14",
  sourceSha: "b".repeat(40),
  evidenceDigest: digest,
  originMode: "memos_weekly",
  memosReleaseTag: "v2.0.28",
});

test("weekly binding is stable, evidence-bound, and uses the plugin Release as docs trigger", () => {
  assert.equal(weekly.prerelease, false);
  assert.equal(weekly.docs_trigger, "local_plugin_release_published");
  assert.equal(weekly.memos_release_tag, "v2.0.28");
  const body = appendLocalPluginReleaseBinding("## Changelog", weekly);
  assert.deepEqual(parseLocalPluginReleaseBinding(body), weekly);
});

test("standalone prerelease binding cannot trigger docs", () => {
  const binding = buildLocalPluginReleaseBinding({
    version: "2.0.15-beta.1",
    tag: "memos-local-plugin-v2.0.15-beta.1",
    sourceSha: "c".repeat(40),
    evidenceDigest: digest,
    originMode: "standalone",
  });
  assert.equal(binding.prerelease, true);
  assert.equal(binding.docs_trigger, "none");
  assert.throws(
    () => buildLocalPluginReleaseBinding({
      version: binding.version,
      tag: binding.tag,
      sourceSha: binding.source_sha,
      evidenceDigest: binding.evidence_digest,
      originMode: "memos_weekly",
      memosReleaseTag: "v2.0.28",
    }),
    /stable local-plugin version/,
  );
});

test("existing weekly Draft may be reused and a matching published Release is idempotent recovery", () => {
  const body = appendLocalPluginReleaseBinding("## Changelog", weekly);
  const base = {
    tagName: weekly.tag,
    name: `MemOS Local Plugin ${weekly.version}`,
    body,
    isPrerelease: false,
    isLatest: false,
    url: "https://github.com/MemTensor/MemOS/releases/tag/memos-local-plugin-v2.0.14",
  };
  assert.deepEqual(
    validateExistingLocalPluginRelease(
      { ...base, isDraft: true },
      { expectedBody: body, expectedBinding: weekly, expectedDraft: true, allowAlreadyPublished: true },
    ),
    { alreadyPublished: false, url: base.url },
  );
  assert.equal(
    validateExistingLocalPluginRelease(
      { ...base, isDraft: false },
      { expectedBody: body, expectedBinding: weekly, expectedDraft: true, allowAlreadyPublished: true },
    ).alreadyPublished,
    true,
  );
});

test("existing Release mismatches fail closed", () => {
  const body = appendLocalPluginReleaseBinding("## Changelog", weekly);
  const base = {
    tagName: weekly.tag,
    name: `MemOS Local Plugin ${weekly.version}`,
    body,
    isDraft: true,
    isPrerelease: false,
    isLatest: false,
  };
  assert.throws(
    () => validateExistingLocalPluginRelease(
      { ...base, body: `${body}\nchanged` },
      { expectedBody: body, expectedBinding: weekly, expectedDraft: true },
    ),
    /different notes/,
  );
  assert.throws(
    () => validateExistingLocalPluginRelease(
      { ...base, isLatest: true },
      { expectedBody: body, expectedBinding: weekly, expectedDraft: true },
    ),
    /must not replace/,
  );
});
