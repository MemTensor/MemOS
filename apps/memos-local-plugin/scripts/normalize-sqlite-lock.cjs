#!/usr/bin/env node
// npm 11 can drop gypfile:false while serializing a lock, then infer a rebuild.
// Never generalize this repair to unreviewed artifacts or run it during install.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith("--")) || path.join(__dirname, "../package-lock.json");
const lock = JSON.parse(fs.readFileSync(file, "utf8"));
const entry = lock.packages?.["node_modules/better-sqlite3"];
const expectedIntegrity = "sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==";
if (lock.packages?.[""]?.dependencies?.["better-sqlite3"] !== "13.0.3" ||
    entry?.version !== "13.0.3" || entry?.integrity !== expectedIntegrity ||
    entry?.resolved !== "https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz") {
  throw new Error("Unreviewed better-sqlite3 lock entry: verify version, URL and integrity before changing the normalizer.");
}
const changed = entry.gypfile !== false || entry.hasInstallScript !== false;
if (changed && args.includes("--check")) throw new Error("SQLite lock metadata drift; run npm run lock:normalize before committing.");
if (changed) {
  entry.gypfile = false;
  entry.hasInstallScript = false;
  fs.writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
}
console.log("SQLite 13.0.3 lock metadata verified");
