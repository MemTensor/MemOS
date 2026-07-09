#!/usr/bin/env node
/**
 * Generate telemetry.credentials.json from environment variables.
 *
 * Called by CI before `npm publish` so the npm package ships with
 * working telemetry credentials while the git repo stays clean.
 *
 * Required env vars:
 *   MEMOS_ARMS_ENDPOINT  — full ARMS RUM endpoint URL
 *   MEMOS_ARMS_PID       — ARMS application PID
 *   MEMOS_ARMS_ENV       — environment tag (default: "prod")
 */

const fs = require("fs");
const path = require("path");

const endpoint = process.env.MEMOS_ARMS_ENDPOINT || "";
const pid = process.env.MEMOS_ARMS_PID || "";
const env = process.env.MEMOS_ARMS_ENV || "prod";

if (!endpoint) {
  console.warn(
    "[generate-telemetry-credentials] MEMOS_ARMS_ENDPOINT not set — " +
      "skipping. Telemetry will be disabled in this build.",
  );
  process.exit(0);
}

const out = path.resolve(__dirname, "..", "telemetry.credentials.json");
fs.writeFileSync(out, JSON.stringify({ endpoint, pid, env }, null, 2) + "\n", "utf-8");
console.log("[generate-telemetry-credentials] wrote " + out);
