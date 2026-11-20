#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const rootArg = args.find((arg) => arg !== "--check");
const root = path.resolve(rootArg || path.join(__dirname, ".."));
const packageJsonPath = path.join(root, "package.json");
const manifestPath = path.join(root, "adapters", "hermes", "plugin.yaml");

function fail(message) {
  process.stderr.write(`Hermes version sync failed: ${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(packageJsonPath)) {
  fail(`package.json not found at ${packageJsonPath}`);
}
if (!fs.existsSync(manifestPath)) {
  fail(`Hermes manifest not found at ${manifestPath}`);
}

let packageJson;
try {
  packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
} catch (error) {
  fail(`cannot parse ${packageJsonPath}: ${error.message}`);
}

const version =
  typeof packageJson.version === "string" ? packageJson.version.trim() : "";
if (!version) {
  fail(`${packageJsonPath} has no non-empty version`);
}

const manifest = fs.readFileSync(manifestPath, "utf8");
const versionLine = /^version:\s*.*$/m;
if (!versionLine.test(manifest)) {
  fail(`${manifestPath} has no top-level version field`);
}

const synchronized = manifest.replace(versionLine, `version: ${version}`);
if (checkOnly) {
  if (synchronized !== manifest) {
    fail(`manifest version does not match package.json (${version})`);
  }
  process.stdout.write(`Hermes manifest version is synchronized: ${version}\n`);
  process.exit(0);
}

if (synchronized !== manifest) {
  fs.writeFileSync(manifestPath, synchronized, "utf8");
  process.stdout.write(`Synchronized Hermes manifest version to ${version}\n`);
} else {
  process.stdout.write(`Hermes manifest version already synchronized: ${version}\n`);
}
