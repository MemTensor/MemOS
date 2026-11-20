import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditPackage } from "./audit-local-plugin-package.mjs";

function withPackage(files, callback) {
  const directory = mkdtempSync(join(tmpdir(), "memos-package-audit-test-"));
  const packageDirectory = join(directory, "package");
  mkdirSync(packageDirectory);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(packageDirectory, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  const tarball = join(directory, "package.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", directory, "package"]);
  try {
    callback(tarball);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("accepts expected package content including public telemetry configuration", () => {
  withPackage(
    {
      "package.json": '{"name":"@memtensor/memos-local-plugin","version":"2.0.13-beta.1"}\n',
      "telemetry.credentials.json": '{"endpoint":"https://example.invalid/rum","pid":"public-id"}\n',
      "dist/index.js": "export const ok = true;\n",
    },
    (tarball) => {
      const report = auditPackage(tarball);
      assert.equal(report.status, "pass");
      assert.equal(report.credential_finding_count, 0);
    },
  );
});

test("rejects credential files and credential-like values", () => {
  withPackage({ ".npmrc": "//registry.npmjs.org/:_authToken=npm_example\n" }, (tarball) => {
    assert.throws(() => auditPackage(tarball), /forbidden path/);
  });
  withPackage({ "dist/config.js": `const token = "github_pat_${"a".repeat(24)}";\n` }, (tarball) => {
    assert.throws(() => auditPackage(tarball), /credential-like value/);
  });
});

test("rejects package symlinks before extraction", () => {
  const directory = mkdtempSync(join(tmpdir(), "memos-package-audit-link-test-"));
  const packageDirectory = join(directory, "package");
  mkdirSync(packageDirectory);
  symlinkSync("/tmp", join(packageDirectory, "unsafe-link"));
  const tarball = join(directory, "package.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", directory, "package"]);
  try {
    assert.throws(() => auditPackage(tarball), /symbolic or hard link/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
