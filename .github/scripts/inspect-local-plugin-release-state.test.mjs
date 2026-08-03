import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReleaseState,
  validateExistingRelease,
  validateExistingTagSource,
  validateExistingTagVersions,
  validateVersionChannel,
} from "./inspect-local-plugin-release-state.mjs";

test("accepts matching stable and prerelease npm channels", () => {
  assert.deepEqual(validateVersionChannel("2.0.13", "latest"), {
    prerelease: false,
    prereleaseChannel: "",
  });
  assert.deepEqual(validateVersionChannel("2.0.13-beta.1", "beta"), {
    prerelease: true,
    prereleaseChannel: "beta",
  });
  assert.deepEqual(validateVersionChannel("2.0.13-rc.1", "next"), {
    prerelease: true,
    prereleaseChannel: "rc",
  });
});

test("rejects malformed versions and mismatched npm channels", () => {
  assert.throws(() => validateVersionChannel("v2.0.13", "latest"), /valid SemVer/);
  assert.throws(() => validateVersionChannel("2.0.13-beta.01", "beta"), /leading zeroes/);
  assert.throws(() => validateVersionChannel("2.0.13", "beta"), /must use npm dist-tag latest/);
  assert.throws(() => validateVersionChannel("2.0.13-beta.1", "latest"), /must not use/);
  assert.throws(() => validateVersionChannel("2.0.13-beta.1", "next"), /must match/);
  assert.throws(() => validateVersionChannel("2.0.13-rc.1", "beta"), /must use npm dist-tag next/);
});

test("requires recovery only for a tag without a GitHub Release", () => {
  assert.equal(
    classifyReleaseState({ tagExists: false, releaseExists: false, recoveryEnabled: false }),
    "fresh",
  );
  assert.equal(
    classifyReleaseState({ tagExists: true, releaseExists: true, recoveryEnabled: false }),
    "complete",
  );
  assert.throws(
    () => classifyReleaseState({ tagExists: true, releaseExists: false, recoveryEnabled: false }),
    /enable recover_existing_npm_release/,
  );
  assert.equal(
    classifyReleaseState({ tagExists: true, releaseExists: false, recoveryEnabled: true }),
    "tag_only",
  );
  assert.throws(
    () => classifyReleaseState({ tagExists: false, releaseExists: true, recoveryEnabled: true }),
    /without its release tag/,
  );
});

test("validates existing GitHub Release state for package-only beta", () => {
  const release = {
    tag_name: "memos-local-plugin-v2.0.13-beta.1",
    draft: false,
    prerelease: true,
    body: "Package-only beta release.",
  };
  assert.doesNotThrow(() =>
    validateExistingRelease(release, {
      releaseTag: release.tag_name,
      shouldBePrerelease: true,
    }),
  );
  assert.throws(
    () =>
      validateExistingRelease(
        { ...release, prerelease: false },
        { releaseTag: release.tag_name, shouldBePrerelease: true },
      ),
    /prerelease=false/,
  );
  assert.throws(
    () =>
      validateExistingRelease(
        { ...release, body: "<!-- doc-agent-release-notes-json {} -->" },
        { releaseTag: release.tag_name, shouldBePrerelease: true },
      ),
    /Doc Agent payload/,
  );
});

test("rejects an existing tag whose package or Hermes version differs", () => {
  const expected = {
    releaseTag: "memos-local-plugin-v2.0.13-beta.1",
    expectedVersion: "2.0.13-beta.1",
  };
  assert.doesNotThrow(() =>
    validateExistingTagVersions(
      { packageVersion: expected.expectedVersion, manifestVersion: expected.expectedVersion },
      expected,
    ),
  );
  assert.throws(
    () =>
      validateExistingTagVersions(
        { packageVersion: "2.0.12", manifestVersion: expected.expectedVersion },
        expected,
      ),
    /contains package version 2\.0\.12/,
  );
  assert.throws(
    () =>
      validateExistingTagVersions(
        { packageVersion: expected.expectedVersion, manifestVersion: "2.0.12" },
        expected,
      ),
    /Hermes manifest version 2\.0\.12/,
  );
});

test("accepts only the selected source or its metadata-only release commit as tag target", () => {
  const expected = {
    releaseTag: "memos-local-plugin-v2.0.13-beta.1",
    expectedSourceSha: "source-sha",
  };
  assert.doesNotThrow(() =>
    validateExistingTagSource(
      { tagCommit: "source-sha", parentCommits: ["older"], changedFiles: [] },
      expected,
    ),
  );
  assert.doesNotThrow(() =>
    validateExistingTagSource(
      {
        tagCommit: "release-sha",
        parentCommits: ["source-sha"],
        changedFiles: [
          "apps/memos-local-plugin/package.json",
          "apps/memos-local-plugin/package-lock.json",
          "apps/memos-local-plugin/adapters/hermes/plugin.yaml",
        ],
      },
      expected,
    ),
  );
  assert.throws(
    () =>
      validateExistingTagSource(
        { tagCommit: "wrong-sha", parentCommits: ["other-source"], changedFiles: [] },
        expected,
      ),
    /does not point to the selected package source/,
  );
  assert.throws(
    () =>
      validateExistingTagSource(
        {
          tagCommit: "release-sha",
          parentCommits: ["source-sha"],
          changedFiles: ["apps/memos-local-plugin/src/index.ts"],
        },
        expected,
      ),
    /changes non-metadata file/,
  );
});
