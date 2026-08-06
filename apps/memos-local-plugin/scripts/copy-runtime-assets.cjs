#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const assets = [
  {
    from: path.join(root, "core", "storage", "migrations"),
    to: path.join(root, "dist", "core", "storage", "migrations"),
  },
];

for (const asset of assets) {
  if (!fs.existsSync(asset.from)) {
    throw new Error(`Runtime asset source missing: ${asset.from}`);
  }
  fs.rmSync(asset.to, { recursive: true, force: true });
  fs.mkdirSync(asset.to, { recursive: true });
  for (const entry of fs.readdirSync(asset.from, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(asset.from, entry.name), path.join(asset.to, entry.name));
  }
}
