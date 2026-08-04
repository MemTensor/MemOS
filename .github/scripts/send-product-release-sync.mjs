#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(String(message));
}

export function validateFormalSyncResponse(payload) {
  if (!payload || typeof payload !== "object") fail("106 formal sync returned a non-object response");
  if (payload.handled !== true) fail(`106 formal sync did not handle the request: ${payload.skip_reason || "unknown reason"}`);
  if (payload.ok !== true) fail(`106 formal sync failed: ${payload.skip_reason || payload.detail || "unknown reason"}`);
  if (payload.source_id !== "openclaw-local-plugin") fail(`106 formal sync returned unexpected source_id ${payload.source_id || "<empty>"}`);
  return payload;
}

async function main() {
  const url = String(process.env.DOC_AGENT_RELEASE_SYNC_URL || "").trim();
  const token = String(process.env.DOC_AGENT_RELEASE_SYNC_TOKEN || "").trim();
  const requestFile = String(process.env.FORMAL_SYNC_REQUEST_FILE || "").trim();
  if (!url) fail("DOC_AGENT_RELEASE_SYNC_URL secret is required for a stable standalone release");
  if (!token) fail("DOC_AGENT_RELEASE_SYNC_TOKEN secret is required for a stable standalone release");
  if (!requestFile) fail("FORMAL_SYNC_REQUEST_FILE is required");

  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: readFileSync(requestFile, "utf8"),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { detail: `non-JSON response (HTTP ${response.status})` };
  }
  if (!response.ok) fail(`106 formal sync HTTP ${response.status}: ${payload.detail || payload.skip_reason || "request failed"}`);
  const result = validateFormalSyncResponse(payload);
  console.log(`106 formal sync accepted ${result.source_id}; idempotent_replay=${Boolean(result.idempotent_replay)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
