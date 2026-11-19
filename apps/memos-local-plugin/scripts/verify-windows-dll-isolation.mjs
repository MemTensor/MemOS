#!/usr/bin/env node
/** Run against the host's real Sharp; each load order starts in a fresh process. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { promisify } from "node:util";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
if (process.platform !== "win32") {
  console.log("SKIP: native DLL collision verification requires Windows.");
  process.exit(0);
}
const hostSharp = option("--host-sharp");
if (!hostSharp)
  throw new Error(
    "Pass --host-sharp <absolute path to the DSH host's sharp package>. Run npm run build first.",
  );
const order = option("--order");
if (!order) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  for (const sequence of ["plugin-first", "host-first"]) {
    const result = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(import.meta.url), ...args, "--order", sequence],
      { env, windowsHide: true, timeout: 180_000 },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  process.exit(0);
}
assert.ok(["plugin-first", "host-first"].includes(order));
const { LocalEmbeddingProvider } = await import(
  "../dist/core/embedding/providers/local.js"
);
const provider = new LocalEmbeddingProvider();
let hostVersion;
let workerPid;
async function hostImage() {
  const sharp = createRequire(import.meta.url)(resolve(hostSharp));
  const image = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  assert.ok(image.length > 0);
  hostVersion = sharp.versions;
}
async function embed() {
  const before = new Set(process.report.getReport().sharedObjects);
  const log = Object.fromEntries(
    ["trace", "debug", "info", "warn", "error"].map((level) => [
      level,
      (message, data) => {
        if (message === "process.request") workerPid = data.pid;
      },
    ]),
  );
  const vectors = await provider.embed(
    ["Synthetic Windows DLL isolation verification."],
    "query",
    {
      config: {
        provider: "local",
        model: option("--model") ?? "Xenova/all-MiniLM-L6-v2",
        dimensions: 384,
        local: {
          cacheDir: option("--cache-dir"),
          offline: args.includes("--offline"),
          loadTimeoutMs: 120_000,
        },
        openRouter: false,
        cache: { enabled: false, maxItems: 0 },
      },
      log,
      signal: AbortSignal.timeout(150_000),
    },
  );
  assert.equal(vectors.length, 1);
  assert.equal(vectors[0].length, 384);
  assert.ok(vectors[0].every(Number.isFinite));
  assert.ok(
    Number.isInteger(workerPid) && workerPid !== process.pid,
    "Local model must run in a separate process",
  );
  const added = process.report
    .getReport()
    .sharedObjects.filter(
      (path) => !before.has(path) && /sharp|vips|onnxruntime/i.test(path),
    );
  assert.deepEqual(
    added,
    [],
    "Local embeddings must not load native model/image libraries into the host",
  );
}
try {
  if (order === "host-first") await hostImage();
  await embed();
  // Exercise the real host image path after model initialization in both orders.
  await hostImage();
  console.log(
    JSON.stringify({
      order,
      passed: true,
      hostPid: process.pid,
      workerPid,
      dimensions: 384,
      hostSharp: hostVersion.sharp,
      hostVips: hostVersion.vips,
    }),
  );
} finally {
  await provider.close();
}
