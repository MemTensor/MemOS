#!/usr/bin/env node
/**
 * Generate telemetry.credentials.json from environment variables.
 *
 * CI calls this before npm packaging so the published artifact can include
 * telemetry credentials while the git repository stays free of cloud resource
 * identifiers.
 *
 * Required env vars:
 *   MEMOS_ARMS_ENDPOINT  - full ARMS RUM endpoint URL
 *   MEMOS_ARMS_PID       - ARMS application PID
 *   MEMOS_ARMS_ENV       - environment tag (default: "prod")
 */

const fs = require("node:fs");
const path = require("node:path");

const endpoint = String(process.env.MEMOS_ARMS_ENDPOINT || "").trim();
const pid = String(process.env.MEMOS_ARMS_PID || "").trim();
const env = String(process.env.MEMOS_ARMS_ENV || "prod").trim() || "prod";

if (!endpoint && !pid) {
  console.warn(
    "[generate-telemetry-credentials] MEMOS_ARMS_ENDPOINT not set; " +
      "skipping. RUM telemetry will be disabled in this build.",
  );
  process.exit(0);
}

if (!endpoint || !pid) {
  console.error(
    "[generate-telemetry-credentials] MEMOS_ARMS_ENDPOINT and MEMOS_ARMS_PID " +
      "must be set together. Refusing to write partial telemetry credentials.",
  );
  process.exit(1);
}

let parsedEndpoint;
try {
  parsedEndpoint = new URL(endpoint);
} catch {
  console.error("[generate-telemetry-credentials] MEMOS_ARMS_ENDPOINT must be a valid URL.");
  process.exit(1);
}

if (!["http:", "https:"].includes(parsedEndpoint.protocol)) {
  console.error("[generate-telemetry-credentials] MEMOS_ARMS_ENDPOINT must use http or https.");
  process.exit(1);
}

const out = path.resolve(__dirname, "..", "telemetry.credentials.json");
fs.writeFileSync(out, JSON.stringify({ endpoint, pid, env }, null, 2) + "\n", "utf-8");
console.log("[generate-telemetry-credentials] wrote " + out);
