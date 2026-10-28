import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatReleaseSourceVersionError,
  inspectReleaseSourceVersion,
  RELEASE_VERSION_FILES,
} from "./validate-release-source-version.mjs";

function fixture(versions) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-release-source-"));
  for (const file of RELEASE_VERSION_FILES) {
    writeFileSync(
      join(root, file),
      `${JSON.stringify({ version: versions[file] }, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

function inspectWorktree(root, expectedVersion) {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    return inspectReleaseSourceVersion({
      expectedVersion,
      sourceRef: "WORKTREE",
    });
  } finally {
    process.chdir(cwd);
  }
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("accepts a source only when all release version files match", () => {
  const versions = Object.fromEntries(
    RELEASE_VERSION_FILES.map((file) => [file, "0.1.20"]),
  );
  const report = inspectWorktree(fixture(versions), "0.1.20");
  assert.equal(report.ok, true);
  assert.equal(report.mismatches.length, 0);
});

test("reports every mismatched or missing version before publish", () => {
  const root = fixture({
    "package.json": "0.1.20",
    "openclaw.plugin.json": "0.1.20-beta.0",
    "moltbot.plugin.json": "",
    "clawdbot.plugin.json": "0.1.19",
  });
  const report = inspectWorktree(root, "0.1.20");
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.mismatches.map((entry) => entry.file),
    [
      "openclaw.plugin.json",
      "moltbot.plugin.json",
      "clawdbot.plugin.json",
    ],
  );

  const message = formatReleaseSourceVersionError(report);
  assert.match(message, /does not modify source files or create a version PR/);
  assert.match(message, /openclaw\.plugin\.json: expected 0\.1\.20, got 0\.1\.20-beta\.0/);
  assert.match(message, /normal reviewed PR/);
});

test("reads the committed Git ref instead of uncommitted worktree changes", () => {
  const versions = Object.fromEntries(
    RELEASE_VERSION_FILES.map((file) => [file, "0.1.20-beta.1"]),
  );
  const root = fixture(versions);
  git(root, ["init"]);
  git(root, ["add", ...RELEASE_VERSION_FILES]);
  git(root, [
    "-c",
    "user.name=release-test",
    "-c",
    "user.email=release-test@example.com",
    "commit",
    "-m",
    "release fixture",
  ]);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ version: "0.1.20" }, null, 2)}\n`,
    "utf8",
  );

  const cwd = process.cwd();
  process.chdir(root);
  try {
    const committed = inspectReleaseSourceVersion({
      expectedVersion: "0.1.20-beta.1",
      sourceRef: "HEAD",
    });
    const worktree = inspectReleaseSourceVersion({
      expectedVersion: "0.1.20-beta.1",
      sourceRef: "WORKTREE",
    });
    assert.equal(committed.ok, true);
    assert.equal(worktree.ok, false);
    assert.equal(worktree.mismatches[0].file, "package.json");
  } finally {
    process.chdir(cwd);
  }
});
