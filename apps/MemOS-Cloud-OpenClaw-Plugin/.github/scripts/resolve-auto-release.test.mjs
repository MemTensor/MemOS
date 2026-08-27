import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  VERSION_FILES,
  inspectPullRequestEvent,
  inspectVersionTransition,
  npmDistTagForVersion,
  validateAutoRelease,
  versionsFromGitRef,
} from "./resolve-auto-release.mjs";

const MERGE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const REPO = "MemTensor/MemOS-Cloud-OpenClaw-Plugin";

function versions(version) {
  return Object.fromEntries(VERSION_FILES.map((file) => [file, version]));
}

function valid(overrides = {}) {
  return {
    eventName: "pull_request",
    merged: "true",
    baseRef: "main",
    headRepo: REPO,
    repository: REPO,
    mergeSha: MERGE_SHA,
    baseSha: BASE_SHA,
    previousVersions: versions("0.1.20"),
    currentVersions: versions("0.1.21"),
    ...overrides,
  };
}

test("accepts a four-file stable version increase without relying on the branch name", () => {
  const result = validateAutoRelease(valid());
  assert.equal(result.ok, true);
  assert.equal(result.eligible, true);
  assert.equal(result.previous_version, "0.1.20");
  assert.equal(result.version, "0.1.21");
  assert.equal(result.npm_dist_tag, "latest");
  assert.equal(result.github_release_prerelease, false);
  assert.equal(result.target_sha, MERGE_SHA);
  assert.equal(result.release_notes_path, ".github/release-notes/v0.1.21.md");
});

test("derives beta, alpha, next, and fallback prerelease npm channels", () => {
  assert.equal(npmDistTagForVersion("0.1.21-beta.1"), "beta");
  assert.equal(npmDistTagForVersion("0.1.21-alpha.2"), "alpha");
  assert.equal(npmDistTagForVersion("0.1.21-next.3"), "next");
  assert.equal(npmDistTagForVersion("0.1.21-rc.1"), "next");

  const beta = validateAutoRelease(
    valid({ currentVersions: versions("0.1.21-beta.0") }),
  );
  assert.equal(beta.ok, true);
  assert.equal(beta.eligible, true);
  assert.equal(beta.npm_dist_tag, "beta");
  assert.equal(beta.github_release_prerelease, true);
});

test("skips ordinary merges whose four version values are unchanged", () => {
  const result = validateAutoRelease(
    valid({ currentVersions: versions("0.1.20") }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.eligible, false);
  assert.match(result.reason, /did not change/);
});

test("fails closed when only some version files change", () => {
  const current = versions("0.1.20");
  current["package.json"] = "0.1.21";
  const result = inspectVersionTransition({
    previousVersions: versions("0.1.20"),
    currentVersions: current,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /all four version files were not updated/);
});

test("fails closed when the merged versions disagree", () => {
  const current = versions("0.1.21");
  current["moltbot.plugin.json"] = "0.1.22";
  const result = validateAutoRelease(valid({ currentVersions: current }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /inconsistent versions/);
});

test("rejects downgrades, equal precedence, and build metadata", () => {
  for (const [previous, current, pattern] of [
    ["0.1.21", "0.1.20", /must increase/],
    ["0.1.21", "0.1.21-beta.1", /must increase/],
    ["0.1.21+build.1", "0.1.21+build.2", /build metadata/],
  ]) {
    const result = inspectVersionTransition({
      previousVersions: versions(previous),
      currentVersions: versions(current),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, pattern);
  }
});

test("accepts beta increments and beta-to-stable promotion", () => {
  for (const [previous, current] of [
    ["0.1.21-beta.0", "0.1.21-beta.1"],
    ["0.1.21-beta.1", "0.1.21"],
  ]) {
    const result = inspectVersionTransition({
      previousVersions: versions(previous),
      currentVersions: versions(current),
    });
    assert.equal(result.ok, true);
    assert.equal(result.eligible, true);
  }
});

test("ignores unmerged, fork, and non-main pull requests", () => {
  for (const input of [
    valid({ merged: "false" }),
    valid({ headRepo: "someone/fork" }),
    valid({ baseRef: "test" }),
  ]) {
    const result = inspectPullRequestEvent(input);
    assert.equal(result.ok, true);
    assert.equal(result.inspect, false);
  }
});

test("requires immutable base and merge SHAs for eligible merged PRs", () => {
  for (const input of [
    valid({ mergeSha: "abc123" }),
    valid({ baseSha: "abc123" }),
  ]) {
    const result = validateAutoRelease(input);
    assert.equal(result.ok, false);
    assert.match(result.reason, /40-character/);
  }
});

test("replays historical beta, stable, and ordinary main merges from immutable refs", () => {
  for (const [mergeSha, expected] of [
    ["066f330d00c710ee3e618312c145f58c51c0d84c", { eligible: true, version: "0.1.20-beta.0", tag: "beta" }],
    ["a317661691bda94054d3d35f8c226e8bfe0018f7", { eligible: true, version: "0.1.20", tag: "latest" }],
    ["bf3f9b32003c58368521b3f11cdb2bef707f3b13", { eligible: false }],
  ]) {
    let baseSha;
    try {
      baseSha = String(
        execFileSync("git", ["rev-parse", `${mergeSha}^1`], {
          encoding: "utf8",
        }),
      ).trim();
    } catch {
      return;
    }
    const result = validateAutoRelease({
      ...valid({
        mergeSha,
        baseSha,
        previousVersions: versionsFromGitRef(baseSha),
        currentVersions: versionsFromGitRef(mergeSha),
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.eligible, expected.eligible);
    if (expected.eligible) {
      assert.equal(result.version, expected.version);
      assert.equal(result.npm_dist_tag, expected.tag);
    }
  }
});
