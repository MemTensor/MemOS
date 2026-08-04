#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const INTENT_SCHEMA = "memos.local-plugin.release-intent.v1";
export const INTENT_MARKER = "doc-agent-local-plugin-release-intent";

function fail(message) {
  throw new Error(String(message));
}

function stableVersion(raw) {
  const value = String(raw || "").trim().replace(/^v/, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    fail(`local plugin release intent requires a stable SemVer; received ${raw || "<empty>"}`);
  }
  return value;
}

export function buildLocalPluginReleaseIntent({
  enabled,
  version = "",
  tag = "",
  sourceSha = "",
  evidenceDigest = "",
} = {}) {
  const active = enabled === true || String(enabled) === "true";
  if (!/^[0-9a-f]{64}$/.test(String(evidenceDigest || ""))) {
    fail("local plugin release intent requires a SHA-256 evidence_digest");
  }
  if (!active) {
    return {
      schema: INTENT_SCHEMA,
      enabled: false,
      version: "",
      tag: "",
      source_sha: "",
      evidence_digest: evidenceDigest,
    };
  }

  const normalizedVersion = stableVersion(version);
  const expectedTag = `memos-local-plugin-v${normalizedVersion}`;
  if (String(tag || "").trim() !== expectedTag) {
    fail(`local plugin release intent tag must equal ${expectedTag}`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(sourceSha || "").trim())) {
    fail("enabled local plugin release intent requires the 40-character published tag commit SHA");
  }
  return {
    schema: INTENT_SCHEMA,
    enabled: true,
    version: `v${normalizedVersion}`,
    tag: expectedTag,
    source_sha: String(sourceSha).trim(),
    evidence_digest: evidenceDigest,
  };
}

export function appendIntentToReleaseNotes(notes, intent) {
  const source = String(notes || "").trimEnd();
  if (!source) fail("MemOS release notes are empty");
  if (source.includes(`<!-- ${INTENT_MARKER}`)) {
    fail("MemOS release notes already contain a local plugin release intent marker");
  }
  return `${source}\n\n<!-- ${INTENT_MARKER}\n${JSON.stringify(intent)}\n-->\n`;
}

export function main() {
  const notesFile = String(process.env.RELEASE_NOTES_FILE || "").trim();
  const outputFile = String(process.env.OUTPUT_RELEASE_NOTES_FILE || notesFile).trim();
  if (!notesFile || !outputFile) fail("RELEASE_NOTES_FILE and OUTPUT_RELEASE_NOTES_FILE are required");
  const intent = buildLocalPluginReleaseIntent({
    enabled: process.env.LOCAL_PLUGIN_RELEASE_ENABLED,
    version: process.env.LOCAL_PLUGIN_VERSION,
    tag: process.env.LOCAL_PLUGIN_TAG,
    sourceSha: process.env.LOCAL_PLUGIN_TAG_SHA,
    evidenceDigest: process.env.LOCAL_PLUGIN_EVIDENCE_DIGEST,
  });
  writeFileSync(outputFile, appendIntentToReleaseNotes(readFileSync(notesFile, "utf8"), intent), "utf8");
  console.log(`Appended ${INTENT_SCHEMA} marker (enabled=${intent.enabled}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
