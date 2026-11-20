#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const INTENT_SCHEMA = "memos.local-plugin.release-intent.v2";
export const INTENT_MARKER = "doc-agent-local-plugin-release-intent";
const MEMOS_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INTENT_RE = new RegExp(
  `<!--\\s*${INTENT_MARKER}\\s*\\n(\\{[^<]*\\})\\s*\\n-->`,
  "g",
);

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
  memosReleaseTag = "",
  pluginReleaseUrl = "",
} = {}) {
  const active = enabled === true || String(enabled) === "true";
  const normalizedMemOSTag = String(memosReleaseTag || "").trim();
  if (!MEMOS_TAG_RE.test(normalizedMemOSTag)) {
    fail(`local plugin release intent requires a stable MemOS release tag; received ${memosReleaseTag || "<empty>"}`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(evidenceDigest || ""))) {
    fail("local plugin release intent requires a SHA-256 evidence_digest");
  }
  if (!active) {
    return {
      schema: INTENT_SCHEMA,
      enabled: false,
      memos_release_tag: normalizedMemOSTag,
      paired_release: false,
      version: "",
      tag: "",
      source_sha: "",
      evidence_digest: evidenceDigest,
      plugin_release_url: "",
      docs_trigger: "none",
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
  const expectedUrl = `https://github.com/MemTensor/MemOS/releases/tag/${expectedTag}`;
  if (String(pluginReleaseUrl || "").trim() !== expectedUrl) {
    fail(`enabled local plugin release intent plugin_release_url must equal ${expectedUrl}`);
  }
  return {
    schema: INTENT_SCHEMA,
    enabled: true,
    memos_release_tag: normalizedMemOSTag,
    paired_release: true,
    version: `v${normalizedVersion}`,
    tag: expectedTag,
    source_sha: String(sourceSha).trim(),
    evidence_digest: evidenceDigest,
    plugin_release_url: expectedUrl,
    docs_trigger: "local_plugin_release_published",
  };
}

export function parseLocalPluginReleaseIntent(body) {
  const matches = [...String(body || "").matchAll(INTENT_RE)];
  if (matches.length !== 1) {
    fail(`MemOS Release must contain exactly one local-plugin intent marker; found ${matches.length}`);
  }
  let payload;
  try {
    payload = JSON.parse(matches[0][1]);
  } catch {
    fail("MemOS local-plugin release intent is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("MemOS local-plugin release intent must be an object");
  }
  if (payload.schema !== INTENT_SCHEMA) {
    fail(`unsupported MemOS local-plugin release intent schema ${payload.schema || "<empty>"}`);
  }
  const rebuilt = buildLocalPluginReleaseIntent({
    enabled: payload.enabled,
    version: payload.version,
    tag: payload.tag,
    sourceSha: payload.source_sha,
    evidenceDigest: payload.evidence_digest,
    memosReleaseTag: payload.memos_release_tag,
    pluginReleaseUrl: payload.plugin_release_url,
  });
  if (JSON.stringify(payload) !== JSON.stringify(rebuilt)) {
    fail("MemOS local-plugin release intent contains unexpected or inconsistent fields");
  }
  return payload;
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
    memosReleaseTag: process.env.MEMOS_RELEASE_TAG,
    pluginReleaseUrl: process.env.LOCAL_PLUGIN_RELEASE_URL,
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
