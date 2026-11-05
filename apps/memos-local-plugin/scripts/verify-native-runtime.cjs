#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
if (Number(process.versions.node.split(".")[0]) < 22) {
  throw new Error("MemOS requires Node.js >=22 in the actual host runtime");
}
const Database = require("better-sqlite3");
const db = new Database(":memory:");
try {
  db.exec("CREATE TABLE probe (v TEXT)");
  db.prepare("INSERT INTO probe VALUES (?)").run("ok");
  assert.equal(db.prepare("SELECT v FROM probe").get().v, "ok");
} finally { db.close(); }
const fromTransformers = createRequire(require.resolve("@huggingface/transformers"));
const ort = fromTransformers("onnxruntime-node");
assert.ok(ort.listSupportedBackends().some(backend => backend.name === "cpu" && backend.bundled));
console.log(JSON.stringify({ node: process.versions.node, electron: process.versions.electron ?? null,
  sqlite: require("better-sqlite3/package.json").version, cpuOnnx: true }));
