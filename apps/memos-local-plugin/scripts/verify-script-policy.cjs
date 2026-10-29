#!/usr/bin/env node
// Negative control: a previously unseen dependency must not execute its script.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run through npm run verify:script-policy with npm 11.17.0");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "memos-script-policy-"));
const dep = path.join(temp, "dependency"), project = path.join(temp, "project");
fs.mkdirSync(dep); fs.mkdirSync(project);
const marker = path.join(temp, "unexpected-script-ran");
const run = (cwd, args) => spawnSync(process.execPath, [npmCli, ...args], {
  cwd, encoding: "utf8", timeout: 30_000,
  env: { ...process.env, MEMOS_POLICY_MARKER: marker },
});
try {
  fs.writeFileSync(path.join(dep, "package.json"), JSON.stringify({name: "memos-unreviewed-policy-probe", version: "1.0.0", scripts: {postinstall: "node postinstall.cjs"}}));
  fs.writeFileSync(path.join(dep, "postinstall.cjs"), 'require("node:fs").writeFileSync(process.env.MEMOS_POLICY_MARKER, "unexpected");');
  const pack = run(dep, ["pack", "--ignore-scripts", "--json"]);
  assert.equal(pack.status, 0, pack.stderr);
  const tar = JSON.parse(pack.stdout)[0].filename;
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({name: "memos-policy-root", version: "1.0.0", private: true,
    dependencies: {"memos-unreviewed-policy-probe": `file:../dependency/${tar}`}, allowScripts: {}}));
  fs.writeFileSync(path.join(project, ".npmrc"), "strict-allow-scripts=true\n");
  const lock = run(project, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.equal(lock.status, 0, lock.stderr);
  const install = run(project, ["ci", "--no-audit", "--no-fund"]);
  assert.notEqual(install.status, 0, "Unreviewed install script did not fail installation");
  assert.match(install.stdout + install.stderr, /memos-unreviewed-policy-probe/);
  assert.equal(fs.existsSync(marker), false, "Unreviewed script executed");
  console.log("PASS: strict npm policy rejected the unknown script without executing it");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
