#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FORMAL_SYNC_SCHEMA = "memos.product-release.formal-sync.v1";
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const CATEGORIES = new Set(["Added", "Improved", "Fixed"]);

function fail(message) {
  throw new Error(String(message));
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
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

function evidenceRefs(evidence) {
  const refs = new Set();
  for (const commit of evidence.commits || []) {
    for (const value of [commit.short_sha, commit.sha, ...(commit.source_refs || [])]) {
      if (String(value || "").trim()) refs.add(String(value).trim());
    }
  }
  for (const pr of evidence.pull_requests || []) {
    if (String(pr.number || "").trim()) refs.add(`#${pr.number}`);
  }
  return refs;
}

export function validateFormalDraft(evidence, draft) {
  const items = Array.isArray(draft?.release_items) ? draft.release_items : [];
  const validRefs = evidenceRefs(evidence);
  const issues = [];
  if (draft?.ok === false || draft?.needs_review) issues.push("draft is not approved by the quality gate");
  if (!items.length) issues.push("release_items is empty");
  if (items.length > 12) issues.push(`release_items exceeds 12: ${items.length}`);
  const covered = new Set();
  items.forEach((item, index) => {
    if (!CATEGORIES.has(String(item.category || ""))) issues.push(`item ${index + 1} has invalid category`);
    const cn = String(item.text_cn || "").trim();
    const en = String(item.text_en || "").trim();
    if (!cn || !CJK_RE.test(cn) || cn.length > 180) issues.push(`item ${index + 1} has invalid Chinese text`);
    if (!en || CJK_RE.test(en) || en.length > 220) issues.push(`item ${index + 1} has invalid English text`);
    const refs = Array.isArray(item.source_refs) ? item.source_refs.map(String).filter(Boolean) : [];
    if (!refs.length) issues.push(`item ${index + 1} has no source_refs`);
    for (const ref of refs) {
      covered.add(ref);
      if (!validRefs.has(ref)) issues.push(`item ${index + 1} has unknown source_ref ${ref}`);
    }
  });
  for (const required of evidence.required_source_refs || []) {
    const accepted = Array.isArray(required.accepted_refs) ? required.accepted_refs.map(String) : [];
    if (!accepted.some((ref) => covered.has(ref))) {
      issues.push(`important source ${required.short_sha || required.sha || "unknown"} is not covered`);
    }
  }
  const coverage = draft?.coverage || {};
  if (coverage.needs_review || Number(coverage.missing_required_count || 0) !== 0) {
    issues.push("draft coverage still requires review");
  }
  if (issues.length) fail(`formal docs sync draft validation failed: ${issues.join("; ")}`);
  return items.map((item) => ({
    category: String(item.category),
    text_cn: String(item.text_cn).trim(),
    text_en: String(item.text_en).trim(),
    source_refs: [...new Set(item.source_refs.map(String))],
  }));
}

export function buildFormalSyncRequest({ version, tag, sourceSha, evidence, draft, publishedAt }) {
  const normalizedVersion = String(version || "").trim().replace(/^v/, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(normalizedVersion)) {
    fail(`formal docs sync requires a stable SemVer; received ${version || "<empty>"}`);
  }
  const expectedTag = `memos-local-plugin-v${normalizedVersion}`;
  if (String(tag || "").trim() !== expectedTag) fail(`formal docs sync tag must equal ${expectedTag}`);
  if (!/^[0-9a-f]{40}$/.test(String(sourceSha || "").trim())) fail("formal docs sync requires a 40-character tag commit SHA");
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) fail("formal docs sync evidence must be an object");
  if (evidence.product_id !== "openclaw-local-plugin") fail("formal docs sync evidence has an unexpected product_id");
  if (evidence.repo !== "MemTensor/MemOS") fail("formal docs sync evidence has an unexpected repository");
  if (String(evidence.target_version || "") !== `v${normalizedVersion}`) {
    fail(`formal docs sync evidence target_version must equal v${normalizedVersion}`);
  }
  if (String(evidence.current_tag || "") !== expectedTag) {
    fail(`formal docs sync evidence current_tag must equal ${expectedTag}`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(String(evidence.git_ref || "").trim())) {
    fail("formal docs sync evidence git_ref must be a commit SHA");
  }
  const releaseItems = validateFormalDraft(evidence, draft);
  const evidenceDigest = sha256Json(evidence);
  return {
    schema: FORMAL_SYNC_SCHEMA,
    source_id: "openclaw-local-plugin",
    source_repo: "MemTensor/MemOS",
    version: `v${normalizedVersion}`,
    tag: expectedTag,
    source_sha: String(sourceSha).trim(),
    evidence_digest: evidenceDigest,
    idempotency_key: `openclaw-local-plugin:${expectedTag}:${sourceSha}:${evidenceDigest}`,
    published_at: String(publishedAt || "").trim(),
    evidence,
    release_notes: {
      release_items: releaseItems,
      coverage: draft.coverage || {},
    },
  };
}

export function main() {
  const evidenceFile = String(process.env.EVIDENCE_FILE || "").trim();
  const draftFile = String(process.env.DRAFT_FILE || "").trim();
  const outputFile = String(process.env.FORMAL_SYNC_REQUEST_FILE || "").trim();
  if (!evidenceFile || !draftFile || !outputFile) fail("EVIDENCE_FILE, DRAFT_FILE, and FORMAL_SYNC_REQUEST_FILE are required");
  const payload = buildFormalSyncRequest({
    version: process.env.RELEASE_VERSION,
    tag: process.env.RELEASE_TAG,
    sourceSha: process.env.RELEASE_TAG_SHA,
    evidence: JSON.parse(readFileSync(evidenceFile, "utf8")),
    draft: JSON.parse(readFileSync(draftFile, "utf8")),
    publishedAt: process.env.RELEASE_PUBLISHED_AT,
  });
  writeFileSync(outputFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  console.log(`Prepared ${FORMAL_SYNC_SCHEMA} request for ${payload.tag}; evidence digest ${payload.evidence_digest}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
