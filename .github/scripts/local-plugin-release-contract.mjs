#!/usr/bin/env node
import { createHash } from "node:crypto";

export const LOCAL_PLUGIN_RELEASE_BINDING_SCHEMA =
  "memos.local-plugin.github-release-binding.v1";
export const LOCAL_PLUGIN_RELEASE_BINDING_MARKER =
  "doc-agent-local-plugin-release-binding";

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MEMOS_RELEASE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BINDING_RE = new RegExp(
  `<!--\\s*${LOCAL_PLUGIN_RELEASE_BINDING_MARKER}\\s*\\n(\\{[^<]*\\})\\s*\\n-->`,
  "g",
);

function fail(message) {
  throw new Error(String(message));
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function normalizeLocalPluginVersion(raw) {
  const version = String(raw || "").trim().replace(/^v/, "");
  const match = SEMVER_RE.exec(version);
  if (!match) fail(`local-plugin Release requires valid SemVer; received ${raw || "<empty>"}`);
  const identifiers = (match[4] || "").split(".").filter(Boolean);
  if (identifiers.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    fail(`numeric prerelease identifiers must not contain leading zeroes; received ${version}`);
  }
  return { version, prerelease: Boolean(match[4]) };
}

export function buildLocalPluginReleaseBinding({
  version,
  tag,
  sourceSha,
  evidenceDigest,
  originMode,
  memosReleaseTag = "",
} = {}) {
  const normalized = normalizeLocalPluginVersion(version);
  const expectedTag = `memos-local-plugin-v${normalized.version}`;
  if (String(tag || "").trim() !== expectedTag) {
    fail(`local-plugin Release tag must equal ${expectedTag}`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(sourceSha || "").trim())) {
    fail("local-plugin Release binding requires a 40-character tag commit SHA");
  }
  if (!/^[0-9a-f]{64}$/.test(String(evidenceDigest || "").trim())) {
    fail("local-plugin Release binding requires a SHA-256 evidence digest");
  }
  if (!new Set(["standalone", "memos_weekly"]).has(originMode)) {
    fail(`local-plugin Release binding has unsupported origin mode ${originMode || "<empty>"}`);
  }
  const normalizedMemOSTag = String(memosReleaseTag || "").trim();
  if (originMode === "memos_weekly") {
    if (normalized.prerelease) fail("MemOS weekly releases may only pair a stable local-plugin version");
    if (!MEMOS_RELEASE_TAG_RE.test(normalizedMemOSTag)) {
      fail("weekly local-plugin Release binding requires a stable MemOS v* release tag");
    }
  } else if (normalizedMemOSTag) {
    fail("standalone local-plugin Release binding must not carry a MemOS release tag");
  }

  return {
    schema: LOCAL_PLUGIN_RELEASE_BINDING_SCHEMA,
    version: `v${normalized.version}`,
    tag: expectedTag,
    source_sha: String(sourceSha).trim(),
    evidence_digest: String(evidenceDigest).trim(),
    origin_mode: originMode,
    memos_release_tag: normalizedMemOSTag,
    prerelease: normalized.prerelease,
    docs_trigger: normalized.prerelease ? "none" : "local_plugin_release_published",
  };
}

export function appendLocalPluginReleaseBinding(notes, binding) {
  const source = String(notes || "").trimEnd();
  if (!source) fail("local-plugin GitHub Release notes are empty");
  if (source.includes(`<!-- ${LOCAL_PLUGIN_RELEASE_BINDING_MARKER}`)) {
    fail("local-plugin GitHub Release notes already contain a binding marker");
  }
  return `${source}\n\n<!-- ${LOCAL_PLUGIN_RELEASE_BINDING_MARKER}\n${JSON.stringify(binding)}\n-->\n`;
}

export function parseLocalPluginReleaseBinding(body) {
  const matches = [...String(body || "").matchAll(BINDING_RE)];
  if (matches.length !== 1) {
    fail(`local-plugin GitHub Release must contain exactly one binding marker; found ${matches.length}`);
  }
  let payload;
  try {
    payload = JSON.parse(matches[0][1]);
  } catch {
    fail("local-plugin GitHub Release binding is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("local-plugin GitHub Release binding must be an object");
  }
  const rebuilt = buildLocalPluginReleaseBinding({
    version: payload.version,
    tag: payload.tag,
    sourceSha: payload.source_sha,
    evidenceDigest: payload.evidence_digest,
    originMode: payload.origin_mode,
    memosReleaseTag: payload.memos_release_tag,
  });
  if (payload.schema !== LOCAL_PLUGIN_RELEASE_BINDING_SCHEMA) {
    fail(`unsupported local-plugin GitHub Release binding schema ${payload.schema || "<empty>"}`);
  }
  if (canonicalJson(payload) !== canonicalJson(rebuilt)) {
    fail("local-plugin GitHub Release binding contains unexpected or inconsistent fields");
  }
  return payload;
}

export function validateExistingLocalPluginRelease(
  release,
  { expectedBody, expectedBinding, expectedDraft, allowAlreadyPublished = false },
) {
  if (!release || typeof release !== "object") fail("GitHub Release lookup returned invalid data");
  if (String(release.tagName || "") !== expectedBinding.tag) {
    fail(`GitHub Release tag ${release.tagName || "<empty>"} does not match ${expectedBinding.tag}`);
  }
  if (String(release.name || "") !== `MemOS Local Plugin ${expectedBinding.version}`) {
    fail(`GitHub Release ${expectedBinding.tag} has an unexpected title`);
  }
  if (Boolean(release.isPrerelease) !== Boolean(expectedBinding.prerelease)) {
    fail(`GitHub Release ${expectedBinding.tag} prerelease state does not match its version`);
  }
  if (release.isLatest === true) {
    fail(`GitHub Release ${expectedBinding.tag} must not replace the MemOS whole-repo Latest Release`);
  }
  if (String(release.body || "").trimEnd() !== String(expectedBody || "").trimEnd()) {
    fail(`GitHub Release ${expectedBinding.tag} already exists with different notes or binding metadata`);
  }
  const parsed = parseLocalPluginReleaseBinding(release.body || "");
  if (canonicalJson(parsed) !== canonicalJson(expectedBinding)) {
    fail(`GitHub Release ${expectedBinding.tag} binding does not match the requested publish`);
  }
  const isDraft = Boolean(release.isDraft);
  if (!expectedDraft && isDraft) {
    fail(`GitHub Release ${expectedBinding.tag} already exists as a Draft; publish or delete it after release-owner review`);
  }
  if (expectedDraft && !isDraft && !allowAlreadyPublished) {
    fail(`GitHub Release ${expectedBinding.tag} was published before its paired MemOS Release`);
  }
  return { alreadyPublished: !isDraft, url: String(release.url || "") };
}
