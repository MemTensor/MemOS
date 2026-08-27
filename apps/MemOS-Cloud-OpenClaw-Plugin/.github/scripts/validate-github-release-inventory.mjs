#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DOC_AGENT_SOURCE_ID = "openclaw-cloud-plugin";

function releasePages(value) {
  if (!Array.isArray(value)) return [];
  if (value.every((item) => Array.isArray(item))) return value;
  return [value];
}

export function flattenReleasePages(value) {
  return releasePages(value)
    .flat()
    .filter((item) => item && typeof item === "object");
}

export function docAgentSourceIds(body) {
  return [
    ...String(body || "").matchAll(
      /<!--\s*doc-agent:\s*source-id=([A-Za-z0-9._-]+)\s*-->/g,
    ),
  ].map((match) => match[1]);
}

function releaseSummary(release) {
  return {
    id: Number(release?.id || 0),
    tag_name: String(release?.tag_name || ""),
    draft: Boolean(release?.draft),
    prerelease: Boolean(release?.prerelease),
    target_commitish: String(release?.target_commitish || ""),
    created_at: String(release?.created_at || ""),
  };
}

export function inspectReleaseInventory({
  pages,
  tag,
  expectedDraft,
  expectedPrerelease,
  expectedTargetCommitish,
  requiredSourceId = DOC_AGENT_SOURCE_ID,
  requireExisting = false,
  allowPublishedForDraftRerun = false,
} = {}) {
  const releaseTag = String(tag || "").trim();
  const matches = flattenReleasePages(pages).filter(
    (release) => String(release?.tag_name || "").trim() === releaseTag,
  );
  const summaries = matches.map(releaseSummary);
  const errors = [];

  if (!releaseTag) {
    errors.push("release tag is required");
  }
  if (matches.length === 0) {
    if (requireExisting) {
      errors.push(`GitHub Release ${releaseTag} was not visible after creation`);
    }
    return {
      ok: errors.length === 0,
      state: "absent",
      tag: releaseTag,
      count: 0,
      releases: [],
      errors,
    };
  }
  if (matches.length > 1) {
    errors.push(
      `found ${matches.length} GitHub Releases for ${releaseTag}; refusing ambiguous release metadata`,
    );
    return {
      ok: false,
      state: "ambiguous",
      tag: releaseTag,
      count: matches.length,
      releases: summaries,
      errors,
    };
  }

  const release = matches[0];
  if (
    typeof expectedDraft === "boolean" &&
    Boolean(release.draft) !== expectedDraft &&
    !(expectedDraft && allowPublishedForDraftRerun && !release.draft)
  ) {
    errors.push(
      `GitHub Release ${releaseTag} draft=${Boolean(release.draft)}, expected ${expectedDraft}`,
    );
  }
  if (
    typeof expectedPrerelease === "boolean" &&
    Boolean(release.prerelease) !== expectedPrerelease
  ) {
    errors.push(
      `GitHub Release ${releaseTag} prerelease=${Boolean(release.prerelease)}, expected ${expectedPrerelease}`,
    );
  }
  const expectedTarget = String(expectedTargetCommitish || "").trim();
  if (
    expectedTarget &&
    String(release.target_commitish || "").trim() !== expectedTarget
  ) {
    errors.push(
      `GitHub Release ${releaseTag} targets ${String(release.target_commitish || "")}, expected ${expectedTarget}`,
    );
  }

  const expectedSourceId = String(requiredSourceId || "").trim();
  const sourceIds = docAgentSourceIds(release.body);
  if (
    expectedSourceId &&
    (sourceIds.length !== 1 || sourceIds[0] !== expectedSourceId)
  ) {
    errors.push(
      `GitHub Release ${releaseTag} must contain exactly one Doc Agent source id ${expectedSourceId}; found ${sourceIds.join(", ") || "none"}`,
    );
  }

  return {
    ok: errors.length === 0,
    state: "existing",
    tag: releaseTag,
    count: 1,
    releases: summaries,
    errors,
  };
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseBoolean(name) {
  const value = required(name);
  if (!["true", "false"].includes(value)) {
    throw new Error(`${name} must be true or false`);
  }
  return value === "true";
}

export function main() {
  const pages = JSON.parse(
    readFileSync(required("RELEASE_INVENTORY_FILE"), "utf8"),
  );
  const report = inspectReleaseInventory({
    pages,
    tag: required("RELEASE_TAG"),
    expectedDraft: parseBoolean("EXPECTED_RELEASE_DRAFT"),
    expectedPrerelease: parseBoolean("EXPECTED_RELEASE_PRERELEASE"),
    expectedTargetCommitish: String(
      process.env.EXPECTED_RELEASE_TARGET || "",
    ).trim(),
    requiredSourceId:
      String(process.env.REQUIRED_DOC_AGENT_SOURCE_ID || "").trim() ||
      DOC_AGENT_SOURCE_ID,
    requireExisting:
      String(process.env.REQUIRE_EXISTING_RELEASE || "false").trim() === "true",
    allowPublishedForDraftRerun:
      String(process.env.ALLOW_PUBLISHED_FOR_DRAFT_RERUN || "false").trim() === "true",
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
