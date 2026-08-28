#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { buildLocalPluginReleaseIntent } from "./append-local-plugin-release-intent.mjs";
import {
  MEMOS_PACKAGE_INIT_PATH,
  MEMOS_PYPROJECT_PATH,
  assertMemOSVersionTexts,
} from "./memos-version.mjs";
import { parseLocalPluginReleaseBinding } from "./local-plugin-release-contract.mjs";

export const PRODUCT_ID = "openclaw-local-plugin";
export const PRODUCT_PATH = "apps/memos-local-plugin";
export const PRODUCT_PATHS = [`${PRODUCT_PATH}/**`];
export const PRODUCT_TITLE = {
  zh: "MemOS 本地插件",
  en: "MemOS Local Plugin",
};
export const RELEASE_CATEGORY_ORDER = ["Added", "Improved", "Fixed"];
export const RELEASE_TO_DOC_CATEGORY = {
  Added: "New Features",
  Improved: "Improvements",
  Fixed: "Bug Fixes",
};
export const MAX_REPAIR_ATTEMPTS = 3;
export const MAX_DRAFT_ATTEMPTS = MAX_REPAIR_ATTEMPTS + 1;
const MAX_RELEASE_ITEMS = 12;
const MAX_TEXT_CN_CHARS = 180;
const MAX_TEXT_EN_CHARS = 220;
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const CJK_GLOBAL_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g;
const LOCAL_PLUGIN_RELEASE_METADATA_PATHS = new Set([
  `${PRODUCT_PATH}/package.json`,
  `${PRODUCT_PATH}/package-lock.json`,
  `${PRODUCT_PATH}/adapters/hermes/plugin.yaml`,
]);
const TOKEN_RE =
  /(github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|npm_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|Bearer\s+[A-Za-z0-9._~+/=-]+)/g;
const INTERNAL_URL_RE =
  /https?:\/\/(?:(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|106\.15\.\d{1,3}\.\d{1,3})[^\s"'<>)]*/g;

export const RELEASE_NOTE_METHODS = [
  {
    source: "github-auto-generated-release-notes",
    url: "https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes",
    applied_as:
      "Keep the public MemOS Release body as GitHub-generated whole-repo What's Changed notes.",
  },
  {
    source: "github-generate-notes-api",
    url: "https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28",
    applied_as:
      "Generate preview-only MemOS Release notes with previous_tag_name before creating a tag or GitHub Release.",
  },
  {
    source: "keep-a-changelog",
    url: "https://keepachangelog.com/en/1.1.0/",
    applied_as:
      "Write Plugin tab entries for humans, grouped by Added, Improved, and Fixed instead of dumping commits.",
  },
  {
    source: "conventional-commits",
    url: "https://www.conventionalcommits.org/en/v1.0.0/",
    applied_as:
      "Use commit type and scope as deterministic hints while requiring real product-path evidence.",
  },
  {
    source: "release-please",
    url: "https://github.com/googleapis/release-please",
    applied_as:
      "Treat feat, fix, perf, and refactor commits as releasable units and filter chore/docs/test noise.",
  },
];

function fail(message) {
  throw new Error(String(message));
}

function warn(message) {
  console.error(`::warning::${message}`);
}

function sh(args, options = {}) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function tryGit(args) {
  try {
    return sh(args);
  } catch {
    return "";
  }
}

export function redact(value) {
  return String(value ?? "")
    .replace(TOKEN_RE, "[REDACTED_TOKEN]")
    .replace(INTERNAL_URL_RE, "[REDACTED_INTERNAL_URL]")
    .replace(/([?&](?:token|access_token|secret|signature|service_id)=)[^&\s"')]+/gi, "$1[REDACTED]");
}

export function cleanVersion(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith("v")) fail("version input must not include a leading v.");
  return value;
}

export function displayVersion(raw) {
  const value = cleanVersion(raw);
  return value ? `v${value}` : "";
}

export function repositoryReleaseNotesPath(rawVersion) {
  const version = cleanVersion(rawVersion);
  if (!parseSemver(version) || version.includes("+")) {
    fail(`Cannot resolve repository release notes for invalid version ${rawVersion || "<empty>"}.`);
  }
  return `.github/release-notes/v${version}.md`;
}

export function validateRepositoryReleaseNotes(notes, { path = "repository release notes" } = {}) {
  const text = String(notes || "").trim();
  if (!text) return "";
  if (text.length > 24000) {
    fail(`${path} exceeds the 24,000-character release-note limit.`);
  }
  if (/<!--\s*doc-agent-/i.test(text)) {
    fail(`${path} must not contain Doc Agent intent, binding, or evidence markers.`);
  }
  if (redact(text) !== text) {
    fail(`${path} contains a credential-like value or internal service URL.`);
  }
  return text;
}

export function prependRepositoryReleaseNotes(generatedNotes, repositoryNotes) {
  const generated = String(generatedNotes || "").trim();
  const authored = validateRepositoryReleaseNotes(repositoryNotes);
  if (!authored) return generated;
  return `${authored}\n\n${generated}`.trim();
}

function readRepositoryReleaseNotes(version, ref) {
  const path = repositoryReleaseNotesPath(version);
  const notes = tryGit(["show", `${ref}:${path}`]);
  return {
    path,
    found: Boolean(notes.trim()),
    body: validateRepositoryReleaseNotes(notes, { path }),
  };
}

export function cleanLocalPluginVersion(raw, label = "local_plugin_version") {
  const value = String(raw || "").trim();
  if (!value) fail(`${label} is required.`);
  if (value.startsWith("v")) fail(`${label} must not include a leading v.`);
  if (!parseSemver(value)) fail(`${label} must be a valid semver version, for example 2.0.12.`);
  if (value.includes("+")) fail(`${label} must not contain SemVer build metadata.`);
  return value;
}

export function parseSemver(raw) {
  const value = String(raw || "").trim().replace(/^v/, "");
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifier(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1;
  if (bNum) return 1;
  return a.localeCompare(b);
}

export function compareSemver(a, b) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return String(a).localeCompare(String(b));
  for (const key of ["major", "minor", "patch"]) {
    if (av[key] !== bv[key]) return av[key] - bv[key];
  }
  if (av.prerelease.length === 0 && bv.prerelease.length === 0) return 0;
  if (av.prerelease.length === 0) return 1;
  if (bv.prerelease.length === 0) return -1;
  const length = Math.max(av.prerelease.length, bv.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (av.prerelease[index] === undefined) return -1;
    if (bv.prerelease[index] === undefined) return 1;
    const order = compareIdentifier(av.prerelease[index], bv.prerelease[index]);
    if (order !== 0) return order;
  }
  return 0;
}

export function incrementPatchVersion(raw) {
  const version = cleanLocalPluginVersion(raw, "local plugin version to auto-increment");
  const parsed = parseSemver(version);
  if (!parsed) fail(`Cannot auto-increment invalid local plugin version: ${version}`);
  if (parsed.prerelease.length) {
    fail(
      `Cannot auto-increment prerelease local plugin version ${displayVersion(version)} automatically. Provide an explicit local_plugin_version guard after release-owner review.`,
    );
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function normalizeLocalPluginReleaseMode(raw = "auto") {
  const value = String(raw || "auto").trim().toLowerCase();
  if (["auto", "skip", "manual"].includes(value)) return value;
  fail(`local_plugin_release_mode must be auto, skip, or manual; received ${raw || "<empty>"}.`);
}

export function deriveReleaseVersionFromMergedPrHead(headRef) {
  const value = String(headRef || "").trim();
  const match = /^(?:dev-v?|release\/v)((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/.exec(
    value,
  );
  if (!match) {
    fail(
      `Automatic MemOS release publishing only accepts merged release branches named ` +
        `release/vX.Y.Z, dev-vX.Y.Z, or dev-X.Y.Z; received ${value || "<empty>"}.`,
    );
  }
  return match[1];
}

export function validatePublishConfirmation({ dryRun, version, localPluginVersion = "", confirmation, autoPostMergeRelease = false }) {
  if (String(dryRun) === "true") return;
  if (String(autoPostMergeRelease) === "true") return;
  const requestedLocalPluginVersion = String(localPluginVersion || "").trim();
  const expected = requestedLocalPluginVersion
    ? `PUBLISH v${cleanVersion(version)} WITH LOCAL PLUGIN v${cleanLocalPluginVersion(requestedLocalPluginVersion)}`
    : `PUBLISH v${cleanVersion(version)}`;
  if (String(confirmation || "").trim() !== expected) {
    fail(`dry_run=false requires publish_confirmation to exactly equal: ${expected}`);
  }
}

export function localPluginTagForVersion(raw) {
  return `memos-local-plugin-v${cleanLocalPluginVersion(raw)}`;
}

export function stableLocalPluginTags(tags, { excludeVersion = "" } = {}) {
  const excluded = String(excludeVersion || "").trim().replace(/^v/, "");
  return tags
    .map((tag) => String(tag || "").trim())
    .map((tag) => {
      const match = /^memos-local-plugin-v(.+)$/.exec(tag);
      if (!match) return null;
      const parsed = parseSemver(match[1]);
      if (!parsed || parsed.prerelease.length || match[1] === excluded) return null;
      return { tag, version: match[1], parsed };
    })
    .filter(Boolean)
    .sort((a, b) => compareSemver(b.version, a.version));
}

export function findPreviousStableLocalPluginTag(tags, { requestedVersion = "" } = {}) {
  return stableLocalPluginTags(tags, { excludeVersion: requestedVersion })[0] || null;
}

export function validateReleaseTarget({ dryRun, targetRef, allowCommitSha = false }) {
  if (String(dryRun) === "true") return;
  const value = String(targetRef || "main").trim();
  if (value !== "main" && !(allowCommitSha && /^[0-9a-f]{40}$/.test(value))) {
    fail("dry_run=false requires target_ref to be exactly main, except for the trusted automatic post-merge SHA path.");
  }
}

export function findPreviousMemOSTag(targetVersion, currentTag, tags) {
  const target = cleanVersion(targetVersion);
  const targetParsed = parseSemver(target);
  if (!targetParsed) fail(`Invalid semver version: ${targetVersion}`);
  const allowPrerelease = targetParsed.prerelease.length > 0;
  return tags
    .map((tag) => String(tag || "").trim())
    .filter((tag) => /^v\d+\.\d+\.\d+/.test(tag))
    .filter((tag) => tag !== currentTag)
    .map((tag) => ({ tag, version: tag.slice(1), parsed: parseSemver(tag) }))
    .filter((item) => item.parsed)
    .filter((item) => allowPrerelease || item.parsed.prerelease.length === 0)
    .filter((item) => compareSemver(item.version, target) < 0)
    .sort((a, b) => compareSemver(b.version, a.version))[0]?.tag || "";
}

function listTags(pattern = "*") {
  return tryGit(["tag", "--list", pattern])
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function npmVersionLookupResult({ status, output }) {
  const text = String(output || "");
  if (status === 0) return true;
  if (/E404|404 Not Found|No match found|is not in this registry/i.test(text)) return false;
  throw new Error(`npm version lookup was inconclusive: ${redact(text).slice(0, 600)}`);
}

function npmVersionExists(version, { overrideName = "LOCAL_PLUGIN_NPM_VERSION_EXISTS_OVERRIDE" } = {}) {
  const override = String(process.env[overrideName] || "").trim();
  if (override === "true") return true;
  if (override === "false") return false;

  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync(
      "npm",
      ["view", `@memtensor/memos-local-plugin@${version}`, "version", "--prefer-online"],
      { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    last = result;
    try {
      return npmVersionLookupResult({
        status: result.status,
        output: `${result.stdout || ""}\n${result.stderr || ""}`,
      });
    } catch (error) {
      if (attempt === 3) throw error;
      warn(`npm version lookup attempt ${attempt}/3 was inconclusive; retrying without guessing release state.`);
      execFileSync("sleep", [String(attempt * 5)]);
    }
  }
  fail(`npm version lookup failed: ${redact(last?.stderr || last?.stdout || "unknown error")}`);
}

export function validatePublishedStableLocalPluginBaseline({ candidate, npmExists, release, sourceIsAncestor }) {
  if (!candidate?.tag || !candidate?.version) {
    fail("Cannot validate an empty local-plugin release baseline.");
  }

  const problems = [];
  if (!npmExists) {
    problems.push(`npm package @memtensor/memos-local-plugin@${candidate.version} is missing`);
  }
  if (!sourceIsAncestor) {
    problems.push(`${candidate.tag} is not an ancestor of the current MemOS release target`);
  }
  if (!release?.exists) {
    problems.push(`GitHub Release ${candidate.tag} is missing`);
  } else {
    if (String(release.tag_name || "") !== candidate.tag) {
      problems.push(`GitHub Release is bound to ${release.tag_name || "<empty>"} instead of ${candidate.tag}`);
    }
    if (release.draft) problems.push(`GitHub Release ${candidate.tag} is still Draft`);
    if (release.prerelease) problems.push(`GitHub Release ${candidate.tag} is marked as a prerelease`);
    if (!String(release.published_at || "").trim()) {
      problems.push(`GitHub Release ${candidate.tag} has no published_at timestamp`);
    }
  }
  if (problems.length) {
    fail(
      `Latest stable-format local-plugin tag ${candidate.tag} is not a completed published baseline: ${problems.join(
        "; ",
      )}. Finish or explicitly recover the pending local-plugin release before starting another MemOS release; do not delete or move a published tag.`,
    );
  }

  return {
    ...candidate,
    npm_verified: true,
    release_verified: true,
    source_ancestor_verified: true,
    release_url: String(release.html_url || ""),
    release_published_at: String(release.published_at),
  };
}

export function validateStableLocalPluginSourceLineage({
  candidate,
  tagCommit,
  tagIsTargetAncestor,
  parentCommits = [],
  parentIsTargetAncestor = false,
  changedFiles = [],
  packageVersion,
  manifestVersion,
}) {
  if (!candidate?.tag || !candidate?.version || !/^[0-9a-f]{40}$/.test(String(tagCommit || ""))) {
    fail("Cannot validate an incomplete stable local-plugin tag source.");
  }
  if (String(packageVersion || "") !== candidate.version) {
    fail(`${candidate.tag} contains package version ${packageVersion || "<missing>"}, expected ${candidate.version}.`);
  }
  if (String(manifestVersion || "") !== candidate.version) {
    fail(`${candidate.tag} contains Hermes manifest version ${manifestVersion || "<missing>"}, expected ${candidate.version}.`);
  }
  if (tagIsTargetAncestor) {
    return { accepted: true, relationship: "target_history" };
  }

  const unexpectedFiles = changedFiles.filter((path) => !LOCAL_PLUGIN_RELEASE_METADATA_PATHS.has(path));
  const requiredMetadata = new Set([
    `${PRODUCT_PATH}/package.json`,
    `${PRODUCT_PATH}/adapters/hermes/plugin.yaml`,
  ]);
  const missingMetadata = [...requiredMetadata].filter((path) => !changedFiles.includes(path));
  if (
    parentCommits.length !== 1 ||
    !parentIsTargetAncestor ||
    unexpectedFiles.length > 0 ||
    missingMetadata.length > 0
  ) {
    const reasons = [];
    if (parentCommits.length !== 1) reasons.push(`expected one parent, found ${parentCommits.length}`);
    if (!parentIsTargetAncestor) reasons.push("its parent is not in the current MemOS release target history");
    if (unexpectedFiles.length) reasons.push(`release commit changes non-metadata file ${unexpectedFiles[0]}`);
    if (missingMetadata.length) reasons.push(`release commit does not update ${missingMetadata.join(" and ")}`);
    fail(
      `${candidate.tag} is outside the current MemOS release target and is not a valid direct release-metadata child: ${reasons.join(
        "; ",
      )}.`,
    );
  }
  return { accepted: true, relationship: "release_metadata_child" };
}

function inspectStableLocalPluginSourceLineage(candidate, targetSha) {
  const tagCommit = sh(["rev-parse", `refs/tags/${candidate.tag}^{commit}`]);
  const tagIsTargetAncestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", tagCommit, targetSha],
    { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).status === 0;
  const commitLine = sh(["rev-list", "--parents", "-n", "1", tagCommit]);
  const [, ...parentCommits] = commitLine.split(/\s+/);
  const parentIsTargetAncestor = parentCommits.length === 1 && spawnSync(
    "git",
    ["merge-base", "--is-ancestor", parentCommits[0], targetSha],
    { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).status === 0;
  const changedFiles = parseLines(tryGit(["diff-tree", "--no-commit-id", "--name-only", "-r", tagCommit]));
  const packageJson = gitShowJson(`refs/tags/${candidate.tag}`, `${PRODUCT_PATH}/package.json`);
  const hermesManifest = tryGit(["show", `refs/tags/${candidate.tag}:${PRODUCT_PATH}/adapters/hermes/plugin.yaml`]);
  const manifestVersion = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(hermesManifest)?.[1] || "";

  return {
    ...validateStableLocalPluginSourceLineage({
      candidate,
      tagCommit,
      tagIsTargetAncestor,
      parentCommits,
      parentIsTargetAncestor,
      changedFiles,
      packageVersion: String(packageJson.version || ""),
      manifestVersion,
    }),
    tag_commit: tagCommit,
  };
}

export async function fetchLocalPluginReleaseState({
  repo,
  tag,
  token = process.env.GITHUB_TOKEN || "",
  allowOverride = true,
}) {
  const override = allowOverride
    ? String(process.env.LOCAL_PLUGIN_BASELINE_RELEASE_STATE_OVERRIDE || "").trim().toLowerCase()
    : "";
  if (override) {
    if (!new Set(["published", "draft", "prerelease", "missing"]).has(override)) {
      fail("LOCAL_PLUGIN_BASELINE_RELEASE_STATE_OVERRIDE must be published, draft, prerelease, or missing.");
    }
    if (override === "missing") return { exists: false, tag_name: tag };
    return {
      exists: true,
      tag_name: tag,
      draft: override === "draft",
      prerelease: override === "prerelease",
      published_at: override === "published" ? "2000-01-01T00:00:00Z" : "",
      html_url: `https://github.com/${repo}/releases/tag/${tag}`,
    };
  }

  if (!String(repo || "").includes("/")) fail(`Invalid GitHub repository for local-plugin baseline lookup: ${repo}`);
  const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "x-github-api-version": "2022-11-28",
        },
      });
      if (response.status === 404) return { exists: false, tag_name: tag };
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${JSON.stringify(payload).slice(0, 500)}`);
      }
      return {
        exists: true,
        id: Number(payload.id || 0),
        tag_name: String(payload.tag_name || ""),
        name: String(payload.name || ""),
        body: String(payload.body || ""),
        draft: Boolean(payload.draft),
        prerelease: Boolean(payload.prerelease),
        published_at: String(payload.published_at || ""),
        html_url: String(payload.html_url || ""),
      };
    } catch (error) {
      lastError = redact(error?.message || error);
      if (attempt === 3) break;
      warn(`local-plugin baseline GitHub Release lookup attempt ${attempt}/3 failed; retrying without guessing release state.`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  fail(`local-plugin baseline GitHub Release lookup failed after 3 attempts: ${lastError}`);
}

export function validateWeeklyStagedLocalPluginRetry({
  candidate,
  memosReleaseTag,
  release,
  source,
} = {}) {
  if (!candidate?.version) {
    fail("Cannot validate an incomplete staged weekly local-plugin release.");
  }
  const expectedTag = localPluginTagForVersion(candidate.version);
  const expectedVersion = displayVersion(candidate.version);
  if (candidate.tag !== expectedTag) {
    fail("Cannot validate an incomplete staged weekly local-plugin release.");
  }
  if (!source?.accepted || !/^[0-9a-f]{40}$/.test(String(source.tag_commit || ""))) {
    fail(`${expectedTag} is not a verified release source for this MemOS target.`);
  }
  if (!release?.exists) {
    fail(`${expectedTag} exists without a matching GitHub Draft Release; refusing automatic reuse.`);
  }
  if (release.tag_name !== expectedTag || release.name !== `MemOS Local Plugin ${expectedVersion}`) {
    fail(`${expectedTag} has unexpected GitHub Release identity; refusing automatic reuse.`);
  }
  if (!release.draft || release.prerelease || release.published_at) {
    fail(`${expectedTag} is not an unpublished stable Draft Release; refusing automatic reuse.`);
  }

  const binding = parseLocalPluginReleaseBinding(release.body || "");
  const mismatches = [];
  if (binding.version !== expectedVersion) mismatches.push("version");
  if (binding.tag !== expectedTag) mismatches.push("tag");
  if (binding.source_sha !== source.tag_commit) mismatches.push("source_sha");
  if (binding.origin_mode !== "memos_weekly") mismatches.push("origin_mode");
  if (binding.memos_release_tag !== memosReleaseTag) mismatches.push("memos_release_tag");
  if (binding.prerelease !== false) mismatches.push("prerelease");
  if (binding.docs_trigger !== "local_plugin_release_published") mismatches.push("docs_trigger");
  if (mismatches.length) {
    fail(`${expectedTag} Draft binding does not match this MemOS weekly release: ${mismatches.join(", ")}.`);
  }

  return {
    verified: true,
    tag: expectedTag,
    version: expectedVersion,
    source_sha: source.tag_commit,
    source_relationship: source.relationship,
    release_url: release.html_url,
  };
}

export function resolveRef(ref) {
  const value = String(ref || "HEAD").trim() || "HEAD";
  const isSimpleBranch = !value.startsWith("origin/") && !value.startsWith("refs/") && !/^[0-9a-f]{40}$/.test(value);
  const candidates = isSimpleBranch ? [`origin/${value}`, value] : [value];
  for (const candidate of candidates) {
    const sha = tryGit(["rev-parse", "--verify", `${candidate}^{commit}`]);
    if (sha) return { ref: candidate, sha };
  }
  fail(`Cannot resolve target ref to a commit: ${value}`);
}

export function assertMemOSVersionAtRef(expectedVersion, targetRef) {
  const ref = String(targetRef || "").trim();
  if (!ref) fail("A target ref is required to validate the MemOS package version.");
  let pyprojectText;
  let packageInitText;
  try {
    pyprojectText = sh(["show", `${ref}:${MEMOS_PYPROJECT_PATH}`]);
    packageInitText = sh(["show", `${ref}:${MEMOS_PACKAGE_INIT_PATH}`]);
  } catch {
    fail(`Cannot read both MemOS package version files from release target ${ref}.`);
  }
  return assertMemOSVersionTexts({ expectedVersion, pyprojectText, packageInitText });
}

export function existingReleaseTagState(currentTag, targetSha) {
  const tagSha = tryGit(["rev-parse", "--verify", `refs/tags/${currentTag}^{commit}`]);
  const target = String(targetSha || "").trim();
  if (!tagSha) {
    return {
      status: "absent",
      exists: false,
      tag_sha: "",
      target_sha: target,
      publish_blocked: false,
      message: `No existing ${currentTag} tag was found; the publish workflow can create it on the target commit.`,
    };
  }
  const matchesTarget = tagSha === target;
  return {
    status: matchesTarget ? "matches_target" : "conflicts_target",
    exists: true,
    tag_sha: tagSha,
    short_tag_sha: tagSha.slice(0, 8),
    target_sha: target,
    short_target_sha: target.slice(0, 8),
    publish_blocked: !matchesTarget,
    message: matchesTarget
      ? `Existing ${currentTag} tag already points to the target commit; the publish workflow can reuse it.`
      : `Existing ${currentTag} tag points to ${tagSha.slice(0, 8)}, but the release target is ${target.slice(0, 8)}. Delete or recreate the manual tag after release-owner review, then rerun.`,
  };
}

function gitShowJson(ref, path) {
  try {
    return JSON.parse(sh(["show", `${ref}:${path}`]));
  } catch {
    return {};
  }
}

function parseLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export function sourceRefsFromText(text) {
  const refs = new Set();
  const value = String(text || "");
  const pattern = /\(#(\d+)\)|\b(?:PR|Fix(?:es)?|Close[sd]?|Refs?|Issue|in)\s+#(\d+)|\/(?:pull|issues)\/(\d+)\b/gi;
  for (const match of value.matchAll(pattern)) refs.add(`#${match[1] || match[2] || match[3]}`);
  return [...refs];
}

function extractPullRequests(commits, releaseAggregateItems, repo) {
  const seen = new Set();
  for (const commit of commits) {
    for (const ref of sourceRefsFromText(`${commit.subject || ""}\n${commit.body_excerpt || ""}`)) seen.add(ref.slice(1));
  }
  for (const item of releaseAggregateItems) {
    for (const ref of sourceRefsFromText(item.text)) seen.add(ref.slice(1));
  }
  return [...seen].sort((a, b) => Number(a) - Number(b)).map((number) => ({
    number,
    url: `https://github.com/${repo}/pull/${number}`,
  }));
}

function commitRefs(commit) {
  const refs = [];
  if (commit.short_sha) refs.push(commit.short_sha);
  if (commit.sha) refs.push(commit.sha);
  if (Array.isArray(commit.source_refs)) refs.push(...commit.source_refs);
  refs.push(...sourceRefsFromText(`${commit.subject || ""}\n${commit.body_excerpt || ""}`));
  return [...new Set(refs)];
}

function revertedCommitKeys(commits) {
  const keys = new Set();
  for (const commit of commits) {
    const text = `${commit.subject || ""}\n${commit.body_excerpt || ""}`;
    if (!/^revert\b/i.test(String(commit.subject || ""))) continue;
    const revertedSha = text.match(/This reverts commit ([0-9a-f]{7,40})\b/i)?.[1];
    if (revertedSha) keys.add(revertedSha);
    const revertedSubject = String(commit.subject || "").match(/^Revert\s+"(.+)"(?:\s+\(#\d+\))?$/i)?.[1];
    if (revertedSubject) keys.add(revertedSubject.toLowerCase());
  }
  return keys;
}

function isRevertedCommit(commit, revertedKeys, { matchSubject = false } = {}) {
  if (!revertedKeys?.size) return false;
  const subject = String(commit.subject || "").toLowerCase();
  return [...revertedKeys].some((key) => {
    const value = String(key).toLowerCase();
    return commit.sha?.startsWith(value) || commit.short_sha?.startsWith(value) || (matchSubject && subject === value);
  });
}

function isUserFacingProductPath(path) {
  const value = String(path || "");
  if (!value.startsWith(`${PRODUCT_PATH}/`)) return false;
  if (/(^|\/)(test|tests|__tests__|fixtures|mocks)\//i.test(value)) return false;
  if (/\.(test|spec|fixture)\.[cm]?[jt]sx?$/i.test(value)) return false;
  if (/\.(md|mdx|rst)$/i.test(value)) return false;
  if (/(^|\/)(README|CHANGELOG|LICENSE)(?:\.[^/]+)?$/i.test(value)) return false;
  if (/(^|\/)(package-lock|npm-shrinkwrap|pnpm-lock|yarn.lock)(?:\.json)?$/i.test(value)) return false;
  if (value === `${PRODUCT_PATH}/package.json`) return false;
  return true;
}

function hasUserFacingProductFileChanges(changedFiles) {
  return changedFiles.some((item) => isUserFacingProductPath(item.path));
}

function hasExplicitUserImpactSignal(subject) {
  return /\b(add|added|enable|enabled|support|supported|fix|fixed|prevent|restore|improve|improved|optimi[sz]e|reduc(?:e|ed)|compat|performance|latency|cpu|memory|provider|hermes|gateway|session|foreground|resource|retry-after|recall|input|bridge|runtime|crash|failure|default|config|dashboard|viewer)\b/i.test(
    String(subject || ""),
  );
}

function isImportantCommit(commit, { revertedKeys = new Set() } = {}) {
  if (isRevertedCommit(commit, revertedKeys)) return false;
  if (commit.has_user_facing_file_changes === false) return false;
  const subject = String(commit.subject || "");
  if (isMaintenanceOnlyCommit(commit)) return false;
  if (/^merge\b/i.test(subject)) return false;
  if (/^(ci|chore|docs|test|style|build)(\([^)]+\))?:/i.test(subject)) return false;
  if (/^chore:\s*update version/i.test(subject)) return false;
  if (/^release:\s*merge\b/i.test(subject)) return false;
  if (/^revert\b/i.test(subject)) return false;
  if (/^(feat|fix|perf)(\([^)]+\))?:/i.test(subject)) return true;
  if (/^refactor(\([^)]+\))?:/i.test(subject)) return hasExplicitUserImpactSignal(subject);
  return hasExplicitUserImpactSignal(subject);
}

function isMaintenanceOnlyCommit(commit) {
  const subject = String(commit?.subject || "");
  if (/^release:\s*merge\b/i.test(subject)) return false;
  if (
    /^release\s*[/:]\s*(?:@memtensor\/memos-local-plugin|memos[-/\s]+local[-/\s]+plugin\b|openclaw\s+local\s+plugin\b)/i.test(
      subject,
    )
  ) {
    return true;
  }
  if (/^(?:chore|build|ci)(\([^)]+\))?:\s*(?:release|bump|update)\b.*(?:@memtensor\/memos-local-plugin|memos-local-plugin)/i.test(subject)) {
    return true;
  }
  if (/^chore:\s*update version/i.test(subject)) return true;
  return false;
}

function isReleaseMergeCommit(commit) {
  return /^release:\s*merge\b/i.test(String(commit?.subject || ""));
}

function commitBodyExcerpt(sha) {
  const body = tryGit(["show", "--no-patch", "--format=%B", sha]);
  return redact(body).slice(0, 24000);
}

function isExplicitLocalPluginAggregate(text) {
  const localPluginPattern =
    /(apps\/memos-local-plugin|memos-local-plugin|local[- ]plugin|openclaw local plugin|plugin gateway|standalone bridge|viewer dashboard|hermes)/i;
  return localPluginPattern.test(String(text || ""));
}

function pathScopedPrRefs(commits, { requireUserFacingFiles = false } = {}) {
  const refs = new Set();
  for (const commit of commits) {
    if (isReleaseMergeCommit(commit) || isMaintenanceOnlyCommit(commit)) continue;
    if (requireUserFacingFiles && commit.has_user_facing_file_changes !== true) continue;
    for (const ref of sourceRefsFromText(commit.subject)) refs.add(ref);
  }
  return refs;
}

function isPathScopedAggregateItem(text, refs, pathRefs) {
  if (refs.some((ref) => pathRefs.has(ref))) return true;
  return isExplicitLocalPluginAggregate(text);
}

function isRevertedAggregateText(text, revertedKeys) {
  if (/^revert\b/i.test(String(text || ""))) return true;
  return isRevertedCommit({ subject: text }, revertedKeys, { matchSubject: true });
}

function releaseAggregateItems(
  commits,
  {
    pathRefs = pathScopedPrRefs(commits, { requireUserFacingFiles: true }),
    revertedKeys = revertedCommitKeys(commits),
  } = {},
) {
  const items = [];
  const seenText = new Set();
  for (const commit of commits) {
    if (!isReleaseMergeCommit(commit)) continue;
    for (const rawLine of String(commit.body_excerpt || "").split("\n")) {
      const line = rawLine.trim();
      if (!/^\*\s+/.test(line)) continue;
      const text = line.replace(/^\*\s+/, "").trim();
      if (!text || text === commit.subject) continue;
      if (/^#\s*/.test(text)) continue;
      if (/^(co-authored-by|signed-off-by|---------|# conflicts:)/i.test(text)) continue;
      if (/^(ci|chore|docs|test|style)(\([^)]+\))?:/i.test(text)) continue;
      if (isMaintenanceOnlyCommit({ subject: text })) continue;
      if (isRevertedAggregateText(text, revertedKeys)) continue;
      const textKey = text.toLowerCase().replace(/\s+/g, " ").trim();
      if (seenText.has(textKey)) continue;
      const refs = sourceRefsFromText(text);
      if (!refs.length) continue;
      if (!refs.some((ref) => pathRefs.has(ref))) continue;
      seenText.add(textKey);
      items.push({
        source_commit: commit.short_sha,
        text: redact(text),
        source_refs: [...new Set([commit.short_sha, ...refs])],
      });
      if (items.length >= 200) break;
    }
  }
  return items;
}

function evidenceCommitsForRelease(commits, aggregateItems, { revertedKeys = new Set() } = {}) {
  const synthetic = aggregateItems
    .filter((item) => !/^revert\b/i.test(String(item.text || "")))
    .filter((item) => !isRevertedAggregateText(item.text, revertedKeys))
    .filter((item) => !isMaintenanceOnlyCommit({ subject: item.text }))
    .map((item) => {
      const prRefs = (item.source_refs || []).filter((ref) => String(ref).startsWith("#"));
      const sourceRefs = prRefs.length ? prRefs : [item.source_commit].filter(Boolean);
      return {
        sha: "",
        short_sha: sourceRefs[0] || item.source_commit || "",
        subject: item.text,
        body_excerpt: "",
        source_refs: [...new Set(sourceRefs)],
        evidence_source: "release_aggregate_item",
        has_user_facing_file_changes: true,
      };
    });
  if (synthetic.length) return synthetic;
  return commits.filter(
    (commit) =>
      !/^revert\b/i.test(String(commit.subject || "")) &&
      !isRevertedCommit(commit, revertedKeys) &&
      !isMaintenanceOnlyCommit(commit),
  );
}

function localPluginSkipReason({ changedFiles = [], importantCommits = [] }) {
  if (!changedFiles.length) {
    return "no local plugin path changes in apps/memos-local-plugin/**";
  }
  if (!hasUserFacingProductFileChanges(changedFiles)) {
    return "local plugin files changed, but only tests/docs/package metadata/release files changed";
  }
  if (!importantCommits.length) {
    return "local plugin files changed, but no user-facing feature/fix/performance evidence was found";
  }
  return "";
}

function packageChanges(previousTag, currentRef) {
  const path = `${PRODUCT_PATH}/package.json`;
  const before = gitShowJson(previousTag, path);
  const after = gitShowJson(currentRef, path);
  const fields = ["name", "version", "main", "types"];
  const changes = fields
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, before: before[field], after: after[field] }));
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const beforeDeps = before[section] || {};
    const afterDeps = after[section] || {};
    const names = new Set([...Object.keys(beforeDeps), ...Object.keys(afterDeps)]);
    for (const name of [...names].sort()) {
      if (beforeDeps[name] !== afterDeps[name]) {
        changes.push({ field: `${section}.${name}`, before: beforeDeps[name], after: afterDeps[name] });
      }
    }
  }
  return changes;
}

function localPluginPackageVersions(previousTag, currentRef) {
  const path = `${PRODUCT_PATH}/package.json`;
  const before = gitShowJson(previousTag, path);
  const after = gitShowJson(currentRef, path);
  const previousVersion = cleanLocalPluginVersion(before.version, "previous local plugin package.json version");
  const currentVersion = cleanLocalPluginVersion(after.version, "local plugin package.json version");
  return {
    previous_version_raw: previousVersion,
    version_raw: currentVersion,
    previous_version: displayVersion(previousVersion),
    version: displayVersion(currentVersion),
    version_changed: previousVersion !== currentVersion,
    version_source: path,
  };
}

export function validateLocalPluginVersionPlan(
  evidence,
  expectedVersionInput = "",
  {
    requestedTagExists = false,
    npmVersionExists = false,
    recoveryEnabled = false,
    stagedReleaseRetryVerified = false,
    releaseMode = "auto",
  } = {},
) {
  const mode = normalizeLocalPluginReleaseMode(releaseMode);
  const expectedVersionRaw = String(expectedVersionInput || "").trim();
  const previousReleasedVersion = cleanLocalPluginVersion(
    evidence.local_plugin_previous_version_raw || evidence.local_plugin_package_previous_version_raw,
    "previous released MemOS local plugin version",
  );
  const previousPackageVersion = cleanLocalPluginVersion(
    evidence.local_plugin_package_previous_version_raw || evidence.local_plugin_previous_version_raw,
    "previous local plugin package.json version",
  );
  const currentPackageVersion = cleanLocalPluginVersion(
    evidence.local_plugin_package_version_raw || evidence.local_plugin_version_raw,
    "local plugin package.json version",
  );
  const hasProductChanges = Boolean(evidence.has_product_changes);
  const hasUserFacingChanges = Boolean(evidence.has_user_facing_product_changes);
  const nextPatchVersion = incrementPatchVersion(previousReleasedVersion);
  const manualVersion = expectedVersionRaw
    ? cleanLocalPluginVersion(expectedVersionRaw, "local_plugin_version input")
    : "";

  if (manualVersion && parseSemver(manualVersion)?.prerelease.length) {
    fail("MemOS weekly local_plugin_version must be a stable SemVer. Use the standalone publisher for prereleases.");
  }
  if (mode === "skip" && manualVersion) {
    fail("local_plugin_release_mode=skip requires local_plugin_version to be blank.");
  }
  if (mode === "manual" && !manualVersion) {
    fail("local_plugin_release_mode=manual requires local_plugin_version.");
  }
  if (mode === "auto" && manualVersion && !hasUserFacingChanges) {
    fail(
      hasProductChanges
        ? "local_plugin_version was provided as an auto-mode guard, but no unpublished user-facing feature/fix/performance evidence was found"
        : "local_plugin_version was provided as an auto-mode guard, but no unpublished apps/memos-local-plugin/** changes were found",
    );
  }

  const releaseRequested = mode === "manual" || (mode === "auto" && hasUserFacingChanges);
  const expectedVersion = releaseRequested ? (manualVersion || nextPatchVersion) : "";

  if (releaseRequested && !hasUserFacingChanges) {
    fail(
      hasProductChanges
        ? "local_plugin_version was provided, but no unpublished user-facing feature/fix/performance evidence was found"
        : "local_plugin_version was provided, but no unpublished apps/memos-local-plugin/** changes were found",
    );
  }
  if (releaseRequested && expectedVersion !== nextPatchVersion) {
    fail(
      `MemOS weekly local_plugin_version must be the next stable patch after ${displayVersion(previousReleasedVersion)}: expected ${displayVersion(nextPatchVersion)}, received ${displayVersion(expectedVersion)}. Use the standalone publisher for an intentional major/minor release.`,
    );
  }
  if (
    releaseRequested &&
    (requestedTagExists || npmVersionExists) &&
    !recoveryEnabled &&
    !stagedReleaseRetryVerified
  ) {
    const usedBy = [requestedTagExists ? "git tag" : "", npmVersionExists ? "npm" : ""].filter(Boolean).join(" and ");
    fail(
      `${displayVersion(expectedVersion)} is already used by ${usedBy}. Normal weekly releases require a new version; enable explicit recovery only for a verified partial failure from this same source.`,
    );
  }
  if (releaseRequested && recoveryEnabled && !npmVersionExists) {
    const detail = requestedTagExists
      ? `, while ${localPluginTagForVersion(expectedVersion)} already exists`
      : "";
    fail(
      `Recovery requires the existing npm version ${displayVersion(expectedVersion)} to be visible${detail}. ` +
        "Wait for registry propagation or resolve the abnormal tag-before-npm state before retrying.",
    );
  }
  if (releaseRequested && stagedReleaseRetryVerified && (!requestedTagExists || npmVersionExists)) {
    fail("Verified staged weekly retry requires an existing release tag and an npm version that is not published yet.");
  }

  const resolvedVersion = releaseRequested ? expectedVersion : previousReleasedVersion;
  const inputIgnoredReason = mode === "skip" && hasUserFacingChanges
    ? "local_plugin_release_mode=skip; unpublished user-facing local plugin changes were detected but will not be released"
    : mode === "skip"
      ? "local_plugin_release_mode=skip"
      : !releaseRequested && hasProductChanges
        ? "local plugin path changes were detected, but no user-facing evidence requires a release"
        : !releaseRequested
          ? "no unpublished local plugin path changes were detected"
          : "";
  const versionSource = releaseRequested
    ? manualVersion
      ? mode === "auto"
        ? "auto_detected_with_manual_guard"
        : "manual_weekly_release_opt_in"
      : "auto_next_patch_from_latest_stable_local_plugin_tag"
    : mode === "skip"
      ? "weekly_release_skip_mode"
      : "latest_stable_local_plugin_tag";
  return {
    ok: true,
    expected_version: expectedVersion ? displayVersion(expectedVersion) : "",
    previous_version: displayVersion(previousReleasedVersion),
    version: displayVersion(resolvedVersion),
    version_changed: releaseRequested,
    version_required: releaseRequested,
    release_requested: releaseRequested,
    pending_local_plugin_changes: !releaseRequested && hasUserFacingChanges,
    release_mode: mode,
    version_source: versionSource,
    auto_incremented: releaseRequested && !manualVersion,
    input_ignored: false,
    input_ignored_reason: inputIgnoredReason,
    input_raw: releaseRequested ? expectedVersion : "",
    input_guard_raw: expectedVersionRaw,
    next_patch_version: displayVersion(nextPatchVersion),
    local_plugin_tag: releaseRequested ? localPluginTagForVersion(expectedVersion) : "",
    requested_tag_exists: Boolean(requestedTagExists),
    npm_version_exists: Boolean(npmVersionExists),
    recovery_enabled: Boolean(recoveryEnabled),
    staged_release_retry_verified: Boolean(stagedReleaseRetryVerified),
    package_previous_version: displayVersion(previousPackageVersion),
    package_version: displayVersion(currentPackageVersion),
    package_version_changed: previousPackageVersion !== currentPackageVersion,
  };
}

function collectPatchSnippets(range, changedFiles) {
  const interesting = changedFiles
    .map((item) => item.path)
    .filter((path) => /\.(ts|tsx|js|mjs|cjs|json|md|yaml|yml|sh|ps1)$/.test(path))
    .slice(0, 12);
  const snippets = [];
  let totalChars = 0;
  for (const path of interesting) {
    if (totalChars > 16000) break;
    const raw = tryGit(["diff", "--unified=1", "--no-ext-diff", range, "--", path]);
    if (!raw) continue;
    const text = redact(raw).slice(0, 5000);
    totalChars += text.length;
    snippets.push({ path, patch: text, truncated: raw.length > text.length });
  }
  return snippets;
}

export function collectLocalPluginEvidence({
  previousTag,
  previousLocalPluginTag,
  previousLocalPluginVersion,
  currentTag,
  currentRef,
  targetVersion,
  repo,
}) {
  const evidenceBaseline = previousLocalPluginTag || previousTag;
  const range = `${evidenceBaseline}..${currentRef}`;
  const commitText = tryGit([
    "log",
    "--format=%H%x09%h%x09%an%x09%ad%x09%s",
    "--date=iso-strict",
    range,
    "--",
    PRODUCT_PATH,
  ]);
  const commits = parseLines(commitText).map((line) => {
    const [sha = "", shortSha = "", author = "", date = "", subject = ""] = line.split("\t");
    const bodyExcerpt = commitBodyExcerpt(sha);
    const changedPaths = parseLines(
      tryGit(["diff-tree", "--no-commit-id", "--name-only", "-r", sha, "--", PRODUCT_PATH]),
    );
    const commit = {
      sha,
      short_sha: shortSha,
      author,
      date,
      subject: redact(subject),
      body_excerpt: bodyExcerpt,
      changed_paths: changedPaths,
      has_user_facing_file_changes: changedPaths.some((path) => isUserFacingProductPath(path)),
    };
    return { ...commit, source_refs: commitRefs(commit) };
  });

  const changedFiles = parseLines(tryGit(["diff", "--name-status", range, "--", PRODUCT_PATH])).map((line) => {
    const parts = line.split("\t");
    const item = { status: parts[0], path: parts[parts.length - 1] };
    if (parts.length === 3) item.old_path = parts[1];
    return item;
  });

  const numstat = parseLines(tryGit(["diff", "--numstat", range, "--", PRODUCT_PATH])).map((line) => {
    const [additions = "0", deletions = "0", path = ""] = line.split("\t");
    return {
      path,
      additions: additions === "-" ? null : Number(additions),
      deletions: deletions === "-" ? null : Number(deletions),
    };
  });

  const revertedKeys = revertedCommitKeys(commits);
  const aggregateItems = releaseAggregateItems(commits, { revertedKeys });
  const evidenceCommits = evidenceCommitsForRelease(commits, aggregateItems, { revertedKeys });
  const hasUserFacingFiles = hasUserFacingProductFileChanges(changedFiles);
  const importantCommits = hasUserFacingFiles
    ? evidenceCommits.filter((commit) => isImportantCommit(commit, { revertedKeys }))
    : [];
  const skipReason = localPluginSkipReason({ changedFiles, importantCommits });
  const localPluginVersion = localPluginPackageVersions(evidenceBaseline, currentRef);
  return {
    product_id: PRODUCT_ID,
    product_title: PRODUCT_TITLE,
    repo,
    release_repo: repo,
    previous_tag: evidenceBaseline,
    current_tag: currentTag,
    memos_previous_tag: previousTag,
    memos_current_tag: currentTag,
    local_plugin_previous_tag: previousLocalPluginTag || "",
    target_version: displayVersion(targetVersion),
    memos_release_version: displayVersion(targetVersion),
    local_plugin_previous_version: displayVersion(previousLocalPluginVersion || localPluginVersion.previous_version_raw),
    local_plugin_previous_version_raw: previousLocalPluginVersion || localPluginVersion.previous_version_raw,
    local_plugin_version: localPluginVersion.version,
    local_plugin_version_raw: localPluginVersion.version_raw,
    local_plugin_version_changed: localPluginVersion.version_changed,
    local_plugin_version_source: localPluginVersion.version_source,
    local_plugin_package_previous_version: localPluginVersion.previous_version,
    local_plugin_package_previous_version_raw: localPluginVersion.previous_version_raw,
    local_plugin_package_version: localPluginVersion.version,
    local_plugin_package_version_raw: localPluginVersion.version_raw,
    local_plugin_package_version_changed: localPluginVersion.version_changed,
    git_ref: currentRef,
    product_paths: PRODUCT_PATHS,
    has_product_changes: changedFiles.length > 0,
    has_user_facing_product_file_changes: hasUserFacingFiles,
    has_user_facing_product_changes: importantCommits.length > 0,
    skip_reason: skipReason,
    commits: evidenceCommits,
    source_commits: commits,
    important_commits: importantCommits,
    release_aggregate_items: aggregateItems,
    reverted_change_keys: [...revertedKeys],
    required_source_refs: importantCommits.map((commit) => ({
      sha: commit.sha,
      short_sha: commit.short_sha,
      subject: commit.subject,
      accepted_refs: commitRefs(commit),
    })),
    pull_requests: extractPullRequests(evidenceCommits, aggregateItems, repo),
    changed_files: changedFiles,
    diff_stat: {
      text: redact(tryGit(["diff", "--stat=200,200", range, "--", PRODUCT_PATH])),
      files: numstat,
    },
    important_diff: {
      [PRODUCT_PATHS[0]]: collectPatchSnippets(range, changedFiles),
    },
    package_changes: packageChanges(evidenceBaseline, currentRef),
    test_changes: changedFiles.filter((item) => /(^|\/)(test|tests|__tests__)\//.test(item.path) || /\.test\./.test(item.path)),
    docs_changes: changedFiles.filter((item) => /\.(md|mdx|rst)$/i.test(item.path)),
    release_note_quality_request: {
      candidate_count: 3,
      max_repair_attempts: MAX_REPAIR_ATTEMPTS,
      methodology: RELEASE_NOTE_METHODS,
      require_source_refs: true,
      require_bilingual_output: true,
      require_docs_preview: true,
      fail_closed: true,
      scoring: [
        "evidence coverage",
        "source_refs validity",
        "Chinese and English language purity",
        "Plugin tab readability",
      ],
      style_policy: [
        "Each bullet should explain the user-facing impact in one sentence.",
        "Avoid generic restatements such as '新增了 X 功能', '优化了 X 性能', or '修复了 X 问题'.",
        "Avoid raw commit subject wording such as 'fix(plugin): ... (#123)'; rewrite it into product-facing copy.",
        "A good bullet names the capability and says why it matters for MemOS local plugin users.",
      ],
      curation_policy: [
        "Use Conventional Commit type/scope as a hint, not as final copy.",
        "Group related commits or PR aggregate items into user-facing topics so Plugin tab output stays readable.",
        "Merge duplicate or near-duplicate bullets and preserve the combined source_refs.",
        "Keep every covered source_ref in the draft and inspection artifact even when several commits become one bullet.",
        "Do not surface chore/docs/test-only noise unless it changes user-visible local plugin behavior.",
      ],
      example_rewrites: [
        {
          weak_cn: "优化了向量扫描性能。",
          better_cn: "优化批量向量扫描规划，降低大数据量本地同步时的处理压力。",
          weak_en: "Improved vector scan performance.",
          better_en: "Improved batch vector scan planning to reduce processing pressure during large local syncs.",
        },
      ],
    },
    target_surface: "memos_docs_plugin_changelog",
    release_context: {
      release_kind: "memos_whole_repo",
      public_release_body: "github_generated_whats_changed",
      docs_product_extraction: "path_filtered",
    },
    release_note_methodology: RELEASE_NOTE_METHODS,
  };
}

async function fetchJsonWithRetry(url, options, { label, attempts = 3, sleepMs = 500 } = {}) {
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${JSON.stringify(payload).slice(0, 500)}`);
      }
      return payload;
    } catch (error) {
      errors.push(redact(error?.message || error));
      if (attempt === attempts) fail(`${label} failed after ${attempts} attempts: ${errors.join(" | ")}`);
      warn(`${label} attempt ${attempt}/${attempts} failed; retrying: ${errors[errors.length - 1]}`);
      await new Promise((resolve) => setTimeout(resolve, sleepMs * attempt));
    }
  }
  fail(`${label} failed.`);
}

export async function generateGitHubReleaseNotes({
  repo,
  currentTag,
  targetSha,
  previousTag,
  token = process.env.GITHUB_TOKEN || "",
  forceLocalFallback = false,
  fallbackWarning = "",
}) {
  const localFallback = (warning = "") => {
    const subjects = parseLines(tryGit(["log", "--format=%s", `${previousTag}..${targetSha}`]));
    return {
      source: warning ? "local-fallback-after-github-error" : "local-fallback",
      name: `Release ${currentTag}`,
      body: [
        "## What's Changed",
        ...subjects.map((subject) => `* ${redact(subject)}`),
        "",
        `**Full Changelog**: https://github.com/${repo || "MemTensor/MemOS"}/compare/${previousTag}...${currentTag}`,
        "",
      ].join("\n"),
      warning,
    };
  };
  if (forceLocalFallback) {
    return localFallback(fallbackWarning || "Existing release tag conflicts with target; using local fallback release notes.");
  }
  if (!token || !repo.includes("/")) {
    return localFallback(token ? "" : "GITHUB_TOKEN is not available; using local fallback release notes.");
  }

  try {
    const payload = await fetchJsonWithRetry(
      `https://api.github.com/repos/${repo}/releases/generate-notes`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-github-api-version": "2026-03-10",
        },
        body: JSON.stringify({
          tag_name: currentTag,
          target_commitish: targetSha,
          previous_tag_name: previousTag,
        }),
      },
      { label: "generate GitHub release notes" },
    );
    if (!String(payload.body || "").trim()) fail("GitHub generated release notes response was empty.");
    return {
      source: "github-generate-notes-api",
      name: String(payload.name || `Release ${currentTag}`),
      body: payload.body,
      warning: "",
    };
  } catch (error) {
    const message = redact(error?.message || error);
    const allowOffline = String(process.env.ALLOW_OFFLINE_DOCS_PREVIEW || "").toLowerCase() === "true";
    if (!allowOffline) throw error;
    warn(`GitHub generated release notes failed; using local fallback: ${message}`);
    return localFallback(message);
  }
}

const FALLBACK_TOPIC_RULES = [
  {
    pattern: /openrouter/i,
    category: "Added",
    text_cn: "**OpenRouter 提供商路由**：新增 OpenRouter 路由与 reasoning 配置支持，便于按配置选择模型提供商。",
    text_en: "**OpenRouter provider routing**: Added OpenRouter routing and reasoning configuration support for model selection.",
  },
  {
    pattern: /circuit breaker|terminal provider|insufficient balance|invalid api key/i,
    category: "Fixed",
    text_cn: "**LLM 熔断保护**：新增终端错误熔断，避免余额或密钥异常时持续触发后台 LLM 请求。",
    text_en: "**LLM circuit breaker**: Added terminal-error protection to stop repeated background LLM calls after billing or credential failures.",
  },
  {
    pattern: /recovery replay request storm|dirty-closed reward|reward recovery/i,
    category: "Fixed",
    text_cn: "**恢复任务稳定性**：优化脏关闭奖励恢复与回放分页，降低恢复过程中的请求风暴风险。",
    text_en: "**Recovery stability**: Improved dirty-closed reward recovery and replay pagination to reduce request storms.",
  },
  {
    pattern: /episode storm|foreground sessions|topic boundary|classifyTimeout|maxTurnsPerEpisode/i,
    category: "Fixed",
    text_cn: "**会话边界稳定性**：补强 episode 风暴保护和前台会话兜底，降低长任务阻塞风险。",
    text_en: "**Session-boundary stability**: Added episode-storm safeguards and foreground-session fallbacks to reduce long-task stalls.",
  },
  {
    pattern: /preserve v7 session defaults|v7-full-chain|default_config\.algorithm\.session|mergeMaxGapMs|followUpMode/i,
    category: "Fixed",
    text_cn: "**V7 会话默认配置**：保留默认 session 参数，避免自定义 follow-up 模式时丢失会话合并窗口。",
    text_en:
      "**V7 session defaults**: Preserved default session parameters so custom follow-up modes keep the merge window settings.",
  },
  {
    pattern: /captureRunner|reflectLlm|batch reflection|reflection scoring|chunk batch/i,
    category: "Improved",
    text_cn: "**采集反思稳定性**：优化批量反思评分与模型路由，降低长会话和 thinking 模型导致的解析风险。",
    text_en: "**Capture reflection stability**: Improved batch reflection scoring and model routing for long sessions and thinking-model setups.",
  },
  {
    pattern: /logging|timezone|memos\.log|logger/i,
    category: "Improved",
    text_cn: "**日志初始化与时区**：补齐本地桥接日志初始化和可配置时区，提升诊断一致性。",
    text_en: "**Logging initialization and timezone**: Added bridge logger initialization and configurable log timezone support.",
  },
  {
    pattern: /bridge|shutdown|session\.close|daemon|orphaned processes|rebuild|dist\/bridge|bridge\.cjs/i,
    category: "Fixed",
    text_cn: "**桥接进程稳定性**：增加会话关闭、shutdown 超时和桥接构建校验，减少事件循环阻塞、孤儿进程与旧产物风险。",
    text_en: "**Bridge process stability**: Added session-close, shutdown-timeout, and bridge rebuild safeguards to reduce event-loop blocking, orphaned processes, and stale artifacts.",
  },
  {
    pattern: /viewer|dashboard|metrics|namespace|500-row|overview/i,
    category: "Fixed",
    text_cn: "**Viewer 指标准确性**：修复命名空间切换和行数上限导致的概览统计偏差。",
    text_en: "**Viewer metric accuracy**: Fixed overview count drift caused by namespace switching and row-limit truncation.",
  },
  {
    pattern: /provider|llm config|embedding|model/i,
    category: "Improved",
    text_cn: "**模型配置与提供商兼容性**：优化 LLM、embedding 与 provider 配置处理，提升不同模型服务的接入稳定性。",
    text_en: "**Model configuration and provider compatibility**: Improved LLM, embedding, and provider configuration handling.",
  },
  {
    pattern: /recall|retrieval|host input|inject|rank|dedupe|keyword|relevance/i,
    category: "Improved",
    text_cn: "**召回相关性与宿主输入处理**：优化本地检索、去重、排序和宿主输入注入流程，提升上下文召回质量。",
    text_en: "**Recall relevance and host input handling**: Improved local retrieval, dedupe, ranking, and host-input injection for better context recall.",
  },
];

function fallbackSubjectText(text) {
  return String(text || "")
    .replace(/^revert\s+"([^"]+)".*$/i, "$1")
    .replace(/^(feat|fix|perf|refactor|chore|docs|test|ci|build|style|revert)(\([^)]+\))?!?:\s*/i, "")
    .replace(/\s+by\s+@\S+.*$/i, "")
    .replace(/\s+\(#\d+\)\s*$/g, "")
    .replace(/\s+#\d+\s*$/g, "")
    .trim();
}

export function fallbackTopicForText(text, { allowGeneric = false } = {}) {
  const source = String(text || "");
  const rule = FALLBACK_TOPIC_RULES.find((item) => item.pattern.test(source));
  if (rule) return rule;
  if (!allowGeneric) return null;
  const cleaned = fallbackSubjectText(source);
  return {
    category: /^feat/i.test(source) ? "Added" : /^fix|^revert/i.test(source) ? "Fixed" : "Improved",
    text_cn: `**${PRODUCT_TITLE.zh}更新**：${cleaned.replace(CJK_GLOBAL_RE, "").trim() || "本地插件能力完成更新。"}`,
    text_en: `**${PRODUCT_TITLE.en} update**: ${cleaned.replace(CJK_GLOBAL_RE, "").trim() || "Release evidence updated."}`,
  };
}

function dedupeFallbackItems(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = `${item.category}:${item.text_cn}:${item.text_en}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        ...item,
        source_refs: [...new Set(item.source_refs || [])],
      });
      continue;
    }
    const existing = byKey.get(key);
    existing.source_refs = [...new Set([...(existing.source_refs || []), ...(item.source_refs || [])])];
  }
  return [...byKey.values()];
}

function localFallbackDraft(evidence) {
  const revertedKeys = new Set((evidence.reverted_change_keys || []).map((item) => String(item).toLowerCase()));
  const aggregateItems = (evidence.release_aggregate_items || [])
    .filter((item) => !/^revert\b/i.test(item.text))
    .filter((item) => !revertedKeys.has(String(item.text || "").toLowerCase()));
  const sourceItems = aggregateItems.length
    ? aggregateItems.map((item) => {
        const prRefs = (item.source_refs || []).filter((ref) => String(ref).startsWith("#"));
        return {
          ...item,
          source_refs: prRefs.length ? prRefs : [item.source_commit].filter(Boolean),
        };
      })
    : evidence.important_commits.map((commit) => ({
        text: commit.subject,
        source_refs: [commit.short_sha],
      }));
  let items = dedupeFallbackItems(sourceItems
    .map((sourceItem) => {
      const topic = fallbackTopicForText(sourceItem.text, { allowGeneric: aggregateItems.length === 0 });
      if (!topic) return null;
      return {
        category: topic.category,
        text_cn: topic.text_cn,
        text_en: topic.text_en,
        source_refs: sourceItem.source_refs?.length ? sourceItem.source_refs : [evidence.important_commits[0]?.short_sha].filter(Boolean),
      };
    })
    .filter(Boolean)).slice(0, 10);
  if (!items.length && evidence.important_commits.length) {
    items = dedupeFallbackItems(evidence.important_commits.map((commit) => {
      const topic = fallbackTopicForText(commit.subject, { allowGeneric: true });
      return {
        category: topic.category,
        text_cn: topic.text_cn,
        text_en: topic.text_en,
        source_refs: [commit.short_sha],
      };
    })).slice(0, 10);
  }
  return {
    ok: true,
    needs_review: false,
    confidence: items.length ? "medium" : "high",
    warnings: ["offline fallback draft; use GitHub Actions with Doc Agent secrets for production quality"],
    release_items: items,
    coverage: {
      required_count: evidence.required_source_refs.length,
      covered_required_count: Math.min(items.length, evidence.required_source_refs.length),
      missing_required_count: Math.max(0, evidence.required_source_refs.length - items.length),
    },
    validation_attempt_count: 1,
    repair_attempt_count: 0,
  };
}

export function normalizeDraft(draft) {
  const releaseItems = Array.isArray(draft?.release_items) ? draft.release_items : [];
  return {
    ok: draft?.ok !== false,
    needs_review: Boolean(draft?.needs_review),
    confidence: draft?.confidence || "",
    warnings: Array.isArray(draft?.warnings) ? draft.warnings.map(redact) : [],
    coverage: draft?.coverage || {},
    release_items: releaseItems.map((item) => ({
      category: String(item.category || "").trim(),
      text_cn: String(item.text_cn || item.text || "").trim(),
      text_en: String(item.text_en || "").trim(),
      source_refs: Array.isArray(item.source_refs) ? item.source_refs.map((ref) => String(ref).trim()).filter(Boolean) : [],
    })),
    validation_attempt_count: Number(draft?.validation_attempt_count || 0),
    repair_attempt_count: Number(draft?.repair_attempt_count || 0),
  };
}

function stripBoldPrefix(text) {
  return String(text || "")
    .trim()
    .replace(/^\*\*[^*]+\*\*\s*[:：]\s*/, "")
    .trim();
}

function isGenericChineseDocsText(text) {
  const body = stripBoldPrefix(text).replace(/\s+/g, "");
  if (/(便于|降低|减少|避免|确保|支持|适配|稳定|同步|处理|接入|配置|演化|管道|压力|场景|大数据量)/.test(body)) {
    return false;
  }
  return /^(新增了|修复了|优化了|增加了).{1,40}(功能|问题|性能|能力)[。.]?$/.test(body);
}

function isGenericEnglishDocsText(text) {
  const body = stripBoldPrefix(text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (/\b(to|so|because|when|during|for)\b/.test(body)) return false;
  return /^(added|fixed|improved|updated|enhanced)\b.{1,60}\b(feature|functionality|issue|bug|problem|performance|capability)\.?$/.test(body);
}

function hasRawCommitSubjectText(text) {
  return /\b(feat|fix|perf|refactor|chore|docs|test|ci|build|style|revert)(\([^)]+\))?!?:\s+/i.test(
    String(text || ""),
  );
}

function duplicateKeyForItem(item) {
  return [item.category, item.text_cn, item.text_en]
    .map((value) =>
      stripBoldPrefix(value)
        .toLowerCase()
        .replace(/[#`*_()[\]{}:：,，。.;；!！?\s-]+/g, " ")
        .trim(),
    )
    .join("|");
}

export function validateDraft(draft, evidence) {
  const operatorSkippedRelease =
    evidence.local_plugin_release_requested === false &&
    evidence.dry_run === false;
  if (operatorSkippedRelease) {
    const issues = [];
    if (!draft.ok) issues.push({ kind: "draft_not_ok", message: "draft ok=false" });
    if (draft.needs_review) issues.push({ kind: "needs_review", message: "draft needs review" });
    if (draft.release_items.length) {
      issues.push({
        kind: "unexpected_release_items",
        message: "release_items must be empty when local-plugin publishing is not requested",
      });
    }
    return {
      ok: issues.length === 0,
      needs_review: issues.length > 0,
      issue_count: issues.length,
      issues,
      skipped_by_operator: true,
      local_plugin_release_not_requested: true,
      coverage: {
        required_count: 0,
        covered_required_count: 0,
        missing_required_count: 0,
        missing_required_refs: [],
      },
    };
  }

  const issues = [];
  const validRefs = new Set();
  for (const commit of evidence.commits || []) {
    for (const ref of commitRefs(commit)) validRefs.add(ref);
  }
  for (const pr of evidence.pull_requests || []) validRefs.add(`#${pr.number}`);

  if (!draft.ok) issues.push({ kind: "draft_not_ok", message: "draft ok=false" });
  if (draft.needs_review) issues.push({ kind: "needs_review", message: "draft needs review" });
  if (!draft.release_items.length && evidence.has_user_facing_product_changes) {
    issues.push({ kind: "empty_release_items", message: "release_items is required when product files changed" });
  }
  if (draft.release_items.length > MAX_RELEASE_ITEMS) {
    issues.push({
      kind: "too_many_release_items",
      message: `release_items must be concise for the Plugin tab; got ${draft.release_items.length}, max ${MAX_RELEASE_ITEMS}`,
    });
  }

  const duplicateItems = new Map();

  for (const [index, item] of draft.release_items.entries()) {
    const duplicateKey = duplicateKeyForItem(item);
    if (duplicateKey && duplicateItems.has(duplicateKey)) {
      issues.push({
        kind: "duplicate_release_item",
        index,
        duplicate_of: duplicateItems.get(duplicateKey),
        message: "duplicate release item should be merged with combined source_refs",
      });
    } else if (duplicateKey) {
      duplicateItems.set(duplicateKey, index);
    }
    if (!RELEASE_CATEGORY_ORDER.includes(item.category)) {
      issues.push({ kind: "invalid_category", index, message: `invalid category ${item.category}` });
    }
    if (!item.text_cn || !CJK_RE.test(item.text_cn)) {
      issues.push({ kind: "invalid_text_cn", index, message: "text_cn must contain Chinese text" });
    }
    if (!item.text_en || CJK_RE.test(item.text_en)) {
      issues.push({ kind: "invalid_text_en", index, message: "text_en must be English without CJK characters" });
    }
    if (item.text_cn && item.text_cn.length > MAX_TEXT_CN_CHARS) {
      issues.push({
        kind: "text_cn_too_long",
        index,
        message: `text_cn is too long for docs rendering; got ${item.text_cn.length}, max ${MAX_TEXT_CN_CHARS}`,
      });
    }
    if (item.text_en && item.text_en.length > MAX_TEXT_EN_CHARS) {
      issues.push({
        kind: "text_en_too_long",
        index,
        message: `text_en is too long for docs rendering; got ${item.text_en.length}, max ${MAX_TEXT_EN_CHARS}`,
      });
    }
    if (isGenericChineseDocsText(item.text_cn)) {
      issues.push({
        kind: "generic_text_cn",
        index,
        message: "text_cn restates the change too generically; include concrete user-facing impact.",
      });
    }
    if (isGenericEnglishDocsText(item.text_en)) {
      issues.push({
        kind: "generic_text_en",
        index,
        message: "text_en restates the change too generically; include concrete user-facing impact.",
      });
    }
    for (const [field, value] of [
      ["text_cn", item.text_cn],
      ["text_en", item.text_en],
    ]) {
      if (hasRawCommitSubjectText(value)) {
        issues.push({
          kind: "raw_commit_subject_text",
          index,
          field,
          message: `${field} should not copy raw Conventional Commit subject text.`,
        });
      }
    }
    if (!item.source_refs.length) {
      issues.push({ kind: "missing_source_refs", index, message: "source_refs is required" });
    }
    for (const ref of item.source_refs) {
      if (!validRefs.has(ref)) {
        issues.push({ kind: "invalid_source_ref", index, ref, message: `source_ref does not match evidence: ${ref}` });
      }
    }
  }

  const coveredRefs = new Set(draft.release_items.flatMap((item) => item.source_refs));
  const missingRequired = [];
  for (const required of evidence.required_source_refs || []) {
    if (!required.accepted_refs.some((ref) => coveredRefs.has(ref))) {
      missingRequired.push(required.short_sha);
    }
  }
  for (const ref of missingRequired) {
    issues.push({ kind: "missing_required_ref", ref, message: `important commit is not covered: ${ref}` });
  }

  return {
    ok: issues.length === 0,
    needs_review: issues.length > 0,
    issue_count: issues.length,
    issues,
    coverage: {
      required_count: evidence.required_source_refs?.length || 0,
      covered_required_count: (evidence.required_source_refs?.length || 0) - missingRequired.length,
      missing_required_count: missingRequired.length,
      missing_required_refs: missingRequired,
    },
  };
}

export async function requestDocAgentDraft(evidence) {
  const dryRunPreview = evidence.dry_run === true || String(evidence.dry_run) === "true";
  const operatorSkippedRelease = !evidence.local_plugin_release_requested && !dryRunPreview;
  if (!evidence.has_user_facing_product_changes || operatorSkippedRelease) {
    const warning = operatorSkippedRelease
      ? "MemOS release did not request a local-plugin release; skipped the Doc Agent draft request for this real release."
      : evidence.skip_reason || "No user-facing MemOS local plugin changes in this MemOS release range.";
    return {
      ok: true,
      needs_review: false,
      confidence: "high",
      warnings: [warning],
      release_items: [],
      coverage: { required_count: 0, covered_required_count: 0, missing_required_count: 0 },
      validation_attempt_count: 1,
      repair_attempt_count: 0,
    };
  }

  const url = String(process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL || "").trim();
  const token = String(process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN || "").trim();
  const allowOffline = String(process.env.ALLOW_OFFLINE_DOCS_PREVIEW || "").toLowerCase() === "true";
  if ((!url || !token) && allowOffline) return normalizeDraft(localFallbackDraft(evidence));
  if (!url) fail("DOC_AGENT_RELEASE_NOTES_DRAFT_URL secret is required for MemOS release docs preview.");
  if (!token) fail("DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN secret is required for MemOS release docs preview.");

  const attempts = [];
  let repairContext = null;
  for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt += 1) {
    const payload = await fetchJsonWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...evidence,
          workflow_retry_context: {
            attempt,
            previous_errors: attempts,
          },
          repair_context: repairContext,
        }),
      },
      { label: "Doc Agent local-plugin docs draft" },
    );
    const draft = normalizeDraft(payload);
    const validation = validateDraft(draft, evidence);
    attempts.push({ attempt, validation });
    if (validation.ok) {
      return {
        ...draft,
        validation_report: validation,
        validation_attempt_count: attempt,
        repair_attempt_count: attempt - 1,
        coverage: validation.coverage,
      };
    }
    repairContext = {
      validation_report: validation,
      instructions: [
        "Repair only the validation issues.",
        "Keep facts within the provided evidence.",
        "Return release_items with category, text_cn, text_en, and source_refs.",
        "For generic_text_cn issues, explain concrete user-facing impact without inventing facts.",
        "For generic_text_en issues, explain concrete user-facing impact in English.",
        "For raw_commit_subject_text issues, remove Conventional Commit prefixes and PR-number prose from the user-facing text.",
        "For duplicate_release_item issues, merge duplicate bullets and combine their source_refs.",
      ],
    };
  }
  fail(`Doc Agent draft failed validation after ${MAX_REPAIR_ATTEMPTS} repair attempts: ${JSON.stringify(attempts.at(-1)?.validation?.issues || [])}`);
}

export function buildDocsPreview(draft, evidence) {
  const localPluginVersion = evidence.local_plugin_version || evidence.current_tag;
  const makeSide = (language) => {
    const categories = {};
    for (const releaseCategory of RELEASE_CATEGORY_ORDER) {
      const docsCategory = RELEASE_TO_DOC_CATEGORY[releaseCategory];
      const changedInfo = draft.release_items
        .filter((item) => item.category === releaseCategory)
        .map((item) => (language === "zh" ? item.text_cn : item.text_en))
        .filter(Boolean);
      if (changedInfo.length) {
        categories[docsCategory] = [
          {
            type: language === "zh" ? PRODUCT_TITLE.zh : PRODUCT_TITLE.en,
            changedInfo,
          },
        ];
      }
    }
    return {
      name: localPluginVersion,
      source: {
        repo: evidence.repo,
        tag: evidence.current_tag,
        memos_release_tag: evidence.current_tag,
        release_url: `https://github.com/${evidence.repo}/releases/tag/${evidence.current_tag}`,
        previous_tag: evidence.previous_tag,
        local_plugin_version: evidence.local_plugin_version,
        local_plugin_previous_version: evidence.local_plugin_previous_version,
        local_plugin_version_source: evidence.local_plugin_version_source,
        local_plugin_version_auto_incremented: evidence.local_plugin_version_auto_incremented,
        local_plugin_version_input_ignored: evidence.local_plugin_version_input_ignored,
        local_plugin_version_input_ignored_reason: evidence.local_plugin_version_input_ignored_reason,
        local_plugin_package_version: evidence.local_plugin_package_version,
        local_plugin_package_previous_version: evidence.local_plugin_package_previous_version,
        product_paths: evidence.product_paths,
      },
      products: {
        plugin: categories,
      },
    };
  };
  return {
    source_id: PRODUCT_ID,
    source_repo: evidence.repo,
    source_ref: evidence.git_ref,
    previous_tag: evidence.previous_tag,
    current_tag: evidence.current_tag,
    memos_release_tag: evidence.current_tag,
    local_plugin_version: evidence.local_plugin_version,
    local_plugin_previous_version: evidence.local_plugin_previous_version,
    local_plugin_version_changed: evidence.local_plugin_version_changed,
    local_plugin_version_source: evidence.local_plugin_version_source,
    local_plugin_version_auto_incremented: evidence.local_plugin_version_auto_incremented,
    local_plugin_version_input_ignored: evidence.local_plugin_version_input_ignored,
    local_plugin_version_input_ignored_reason: evidence.local_plugin_version_input_ignored_reason,
    local_plugin_package_version: evidence.local_plugin_package_version,
    local_plugin_package_previous_version: evidence.local_plugin_package_previous_version,
    product_paths: evidence.product_paths,
    has_product_changes: evidence.has_product_changes,
    has_user_facing_product_changes: evidence.has_user_facing_product_changes,
    skip_reason: evidence.skip_reason,
    docs_action: evidence.local_plugin_release_requested
      ? draft.release_items.length
        ? "preview_plugin_tab_entry"
        : "skip_plugin_tab_entry"
      : evidence.pending_local_plugin_changes
        ? "skip_pending_local_plugin_release"
        : "skip_plugin_tab_entry",
    would_create_docs_pr: false,
    files: ["content/cn/plugin-changelog.yml", "content/en/plugin-changelog.yml"],
    cn: makeSide("zh"),
    en: makeSide("en"),
  };
}

export function docsPreviewMarkdown(preview, draft, evidence) {
  const lines = [
    `# ${PRODUCT_TITLE.zh}-${evidence.local_plugin_version || evidence.current_tag}`,
    "",
    `- source: ${evidence.repo}`,
    `- memos_release_range: ${evidence.memos_previous_tag}...${evidence.memos_current_tag}`,
    `- local_plugin_evidence_range: ${evidence.local_plugin_previous_tag}...${evidence.git_ref}`,
    `- local_plugin_version: ${evidence.local_plugin_version || "n/a"}`,
    `- local_plugin_previous_version: ${evidence.local_plugin_previous_version || "n/a"}`,
    `- local_plugin_version_source: ${evidence.local_plugin_version_source || `${PRODUCT_PATH}/package.json`}`,
    `- local_plugin_version_auto_incremented: ${Boolean(evidence.local_plugin_version_auto_incremented)}`,
    `- local_plugin_version_input_ignored: ${Boolean(evidence.local_plugin_version_input_ignored)}`,
    `- local_plugin_version_input_ignored_reason: ${evidence.local_plugin_version_input_ignored_reason || "n/a"}`,
    `- local_plugin_package_version: ${evidence.local_plugin_package_version || "n/a"}`,
    `- local_plugin_package_previous_version: ${evidence.local_plugin_package_previous_version || "n/a"}`,
    `- product_paths: ${evidence.product_paths.join(", ")}`,
    "",
  ];
  if (!draft.release_items.length) {
    lines.push(evidence.skip_reason || "No MemOS local plugin docs entries were generated for this MemOS release range.", "");
    return lines.join("\n");
  }
  for (const [language, label, field] of [
    ["cn", "中文", "text_cn"],
    ["en", "English", "text_en"],
  ]) {
    lines.push(`## ${label}`, "");
    for (const releaseCategory of RELEASE_CATEGORY_ORDER) {
      const items = draft.release_items.filter((item) => item.category === releaseCategory);
      if (!items.length) continue;
      lines.push(`### ${RELEASE_TO_DOC_CATEGORY[releaseCategory]}`, "");
      for (const item of items) {
        lines.push(`- ${item[field]}`);
      }
      lines.push("");
    }
    if (!Object.keys(preview[language].products.plugin).length) lines.push("No entries.", "");
  }
  lines.push("## Source Refs", "");
  for (const item of draft.release_items) {
    lines.push(`- ${item.category}: ${item.source_refs.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function appendOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const text = String(value ?? "");
  writeFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${text}\nEOF\n`, { flag: "a" });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

export async function run() {
  const autoPostMergeRelease = String(process.env.AUTO_POST_MERGE_RELEASE || "") === "true";
  const releaseVersionInput = process.env.RELEASE_VERSION || (
    autoPostMergeRelease ? deriveReleaseVersionFromMergedPrHead(process.env.MERGED_PR_HEAD_REF) : ""
  );
  const version = cleanVersion(releaseVersionInput);
  if (!version) fail("RELEASE_VERSION is required.");
  const parsedReleaseVersion = parseSemver(version);
  if (!parsedReleaseVersion) fail(`Invalid semver version: ${version}`);
  if (parsedReleaseVersion.prerelease.length || version.includes("+")) {
    fail(`MemOS Release — Publish only accepts a stable X.Y.Z version; received ${version}.`);
  }

  const dryRun = String(process.env.DRY_RUN ?? "true");
  const createDraftRelease = String(process.env.CREATE_DRAFT_RELEASE ?? "true") !== "false";
  const localPluginVersionInput = String(process.env.LOCAL_PLUGIN_VERSION || "").trim();
  const localPluginReleaseMode = autoPostMergeRelease
    ? "auto"
    : normalizeLocalPluginReleaseMode(process.env.LOCAL_PLUGIN_RELEASE_MODE || "auto");
  const localPluginRecoveryEnabled = String(process.env.RECOVER_EXISTING_LOCAL_PLUGIN_PUBLISH || "") === "true";
  if (localPluginRecoveryEnabled && !localPluginVersionInput) {
    fail("recover_existing_local_plugin_publish=true requires local_plugin_version.");
  }

  const currentTag = `v${version}`;
  const repo = process.env.GITHUB_REPOSITORY || "MemTensor/MemOS";
  const targetRefInput = process.env.TARGET_REF || "main";
  validateReleaseTarget({ dryRun, targetRef: targetRefInput, allowCommitSha: autoPostMergeRelease });
  const target = resolveRef(
    autoPostMergeRelease || dryRun === "true" ? targetRefInput : "refs/remotes/origin/main",
  );
  const memosPackageVersion = assertMemOSVersionAtRef(version, target.sha);
  const allTags = listTags();
  const previousTag = process.env.PREVIOUS_TAG || findPreviousMemOSTag(version, currentTag, allTags);
  if (!previousTag) fail(`Cannot find previous MemOS v* tag before ${currentTag}.`);
  const requestedLocalPluginVersion = localPluginVersionInput
    ? cleanLocalPluginVersion(localPluginVersionInput, "local_plugin_version input")
    : "";
  let previousLocalPlugin = findPreviousStableLocalPluginTag(allTags, {
    requestedVersion: requestedLocalPluginVersion,
  });
  if (!previousLocalPlugin) {
    fail("Cannot find a previous stable memos-local-plugin-v* tag for local plugin evidence and version validation.");
  }
  let stagedLocalPluginRetry = null;
  if (!requestedLocalPluginVersion) {
    const latestStableNpmExists = npmVersionExists(previousLocalPlugin.version, {
      overrideName: "LOCAL_PLUGIN_BASELINE_NPM_VERSION_EXISTS_OVERRIDE",
    });
    if (!latestStableNpmExists) {
      const latestStableRelease = await fetchLocalPluginReleaseState({
        repo,
        tag: previousLocalPlugin.tag,
        allowOverride: false,
      });
      if (!latestStableRelease.exists || !latestStableRelease.draft || latestStableRelease.prerelease) {
        fail(
          `Latest stable-format local-plugin tag ${previousLocalPlugin.tag} is absent from npm and is not a valid weekly Draft retry.`,
        );
      }
      const stagedSource = inspectStableLocalPluginSourceLineage(previousLocalPlugin, target.sha);
      stagedLocalPluginRetry = validateWeeklyStagedLocalPluginRetry({
        candidate: previousLocalPlugin,
        memosReleaseTag: currentTag,
        release: latestStableRelease,
        source: stagedSource,
      });
      previousLocalPlugin = findPreviousStableLocalPluginTag(allTags, {
        requestedVersion: stagedLocalPluginRetry.version,
      });
      if (!previousLocalPlugin) {
        fail(
          `${stagedLocalPluginRetry.tag} is a verified staged retry, but no earlier completed stable local-plugin baseline exists.`,
        );
      }
    }
  }
  const previousLocalPluginRelease = await fetchLocalPluginReleaseState({
    repo,
    tag: previousLocalPlugin.tag,
  });
  const previousLocalPluginSource = inspectStableLocalPluginSourceLineage(previousLocalPlugin, target.sha);
  const verifiedPreviousLocalPlugin = validatePublishedStableLocalPluginBaseline({
    candidate: previousLocalPlugin,
    npmExists: npmVersionExists(previousLocalPlugin.version, {
      overrideName: "LOCAL_PLUGIN_BASELINE_NPM_VERSION_EXISTS_OVERRIDE",
    }),
    release: previousLocalPluginRelease,
    sourceIsAncestor: previousLocalPluginSource.accepted,
  });
  const existingTag = existingReleaseTagState(currentTag, target.sha);
  if (existingTag.publish_blocked && dryRun !== "true") {
    fail(existingTag.message);
  }
  if (existingTag.publish_blocked) {
    warn(existingTag.message);
  }

  const releaseNotes = await generateGitHubReleaseNotes({
    repo,
    currentTag,
    targetSha: target.sha,
    previousTag,
    forceLocalFallback: existingTag.publish_blocked,
    fallbackWarning: existingTag.message,
  });
  const repositoryReleaseNotes = readRepositoryReleaseNotes(version, target.sha);
  releaseNotes.body = prependRepositoryReleaseNotes(releaseNotes.body, repositoryReleaseNotes.body);
  if (repositoryReleaseNotes.found) {
    releaseNotes.source = `repository-authored+${releaseNotes.source}`;
  }
  releaseNotes.repository_notes_file = repositoryReleaseNotes.path;
  releaseNotes.repository_notes_found = repositoryReleaseNotes.found;
  const evidence = collectLocalPluginEvidence({
    previousTag,
    previousLocalPluginTag: verifiedPreviousLocalPlugin.tag,
    previousLocalPluginVersion: verifiedPreviousLocalPlugin.version,
    currentTag,
    currentRef: target.sha,
    targetVersion: version,
    repo,
  });
  let localPluginVersionPlan = validateLocalPluginVersionPlan(evidence, localPluginVersionInput, {
    requestedTagExists: false,
    npmVersionExists: false,
    recoveryEnabled: localPluginRecoveryEnabled,
    releaseMode: localPluginReleaseMode,
  });
  const plannedLocalPluginVersion = localPluginVersionPlan.release_requested
    ? localPluginVersionPlan.input_raw
    : "";
  const plannedLocalPluginTag = plannedLocalPluginVersion
    ? localPluginTagForVersion(plannedLocalPluginVersion)
    : "";
  const plannedLocalPluginTagExists = Boolean(
    plannedLocalPluginTag && tryGit(["rev-parse", "--verify", `refs/tags/${plannedLocalPluginTag}^{commit}`]),
  );
  const plannedNpmVersionExists = plannedLocalPluginVersion
    ? npmVersionExists(plannedLocalPluginVersion)
    : false;
  if (
    autoPostMergeRelease &&
    plannedLocalPluginVersion &&
    plannedLocalPluginTagExists &&
    !plannedNpmVersionExists
  ) {
    if (stagedLocalPluginRetry?.tag && stagedLocalPluginRetry.tag !== plannedLocalPluginTag) {
      fail(
        `Verified staged retry ${stagedLocalPluginRetry.tag} does not match planned tag ${plannedLocalPluginTag}.`,
      );
    }
    if (!stagedLocalPluginRetry) {
      const stagedCandidate = {
        tag: plannedLocalPluginTag,
        version: plannedLocalPluginVersion,
      };
      const stagedSource = inspectStableLocalPluginSourceLineage(stagedCandidate, target.sha);
      const stagedRelease = await fetchLocalPluginReleaseState({
        repo,
        tag: plannedLocalPluginTag,
        allowOverride: false,
      });
      stagedLocalPluginRetry = validateWeeklyStagedLocalPluginRetry({
        candidate: stagedCandidate,
        memosReleaseTag: currentTag,
        release: stagedRelease,
        source: stagedSource,
      });
    }
  }
  localPluginVersionPlan = validateLocalPluginVersionPlan(evidence, localPluginVersionInput, {
    requestedTagExists: plannedLocalPluginTagExists,
    npmVersionExists: plannedNpmVersionExists,
    recoveryEnabled: localPluginRecoveryEnabled,
    stagedReleaseRetryVerified: Boolean(stagedLocalPluginRetry?.verified),
    releaseMode: localPluginReleaseMode,
  });
  validatePublishConfirmation({
    dryRun,
    version,
    localPluginVersion: localPluginVersionPlan.release_requested
      ? localPluginVersionPlan.input_raw
      : "",
    confirmation: process.env.PUBLISH_CONFIRMATION || "",
    autoPostMergeRelease,
  });
  evidence.local_plugin_version_plan = localPluginVersionPlan;
  evidence.local_plugin_release_mode = localPluginReleaseMode;
  evidence.local_plugin_staged_retry = stagedLocalPluginRetry;
  evidence.local_plugin_baseline = {
    tag: verifiedPreviousLocalPlugin.tag,
    version: displayVersion(verifiedPreviousLocalPlugin.version),
    npm_verified: verifiedPreviousLocalPlugin.npm_verified,
    release_verified: verifiedPreviousLocalPlugin.release_verified,
    source_ancestor_verified: verifiedPreviousLocalPlugin.source_ancestor_verified,
    source_relationship: previousLocalPluginSource.relationship,
    release_url: verifiedPreviousLocalPlugin.release_url,
    release_published_at: verifiedPreviousLocalPlugin.release_published_at,
  };
  evidence.auto_post_merge_release = autoPostMergeRelease;
  evidence.memos_project_version = displayVersion(memosPackageVersion.version);
  evidence.create_draft_release = createDraftRelease;
  evidence.local_plugin_previous_version = localPluginVersionPlan.previous_version;
  evidence.local_plugin_previous_version_raw = localPluginVersionPlan.previous_version.replace(/^v/, "");
  evidence.local_plugin_version = localPluginVersionPlan.version;
  evidence.local_plugin_version_raw = localPluginVersionPlan.version.replace(/^v/, "");
  evidence.local_plugin_version_changed = localPluginVersionPlan.version_changed;
  evidence.local_plugin_version_source = localPluginVersionPlan.version_source;
  evidence.local_plugin_version_auto_incremented = localPluginVersionPlan.auto_incremented;
  evidence.local_plugin_version_input_ignored = localPluginVersionPlan.input_ignored;
  evidence.local_plugin_version_input_ignored_reason = localPluginVersionPlan.input_ignored_reason;
  evidence.local_plugin_version_input_raw = localPluginVersionPlan.input_raw;
  evidence.local_plugin_version_guard_raw = localPluginVersionPlan.input_guard_raw;
  evidence.local_plugin_release_requested = localPluginVersionPlan.release_requested;
  evidence.pending_local_plugin_changes = localPluginVersionPlan.pending_local_plugin_changes;
  evidence.local_plugin_tag = localPluginVersionPlan.local_plugin_tag;
  evidence.local_plugin_tag_exists = localPluginVersionPlan.requested_tag_exists;
  evidence.local_plugin_npm_version_exists = localPluginVersionPlan.npm_version_exists;
  evidence.local_plugin_recovery_enabled = localPluginVersionPlan.recovery_enabled;
  evidence.local_plugin_next_patch_version = localPluginVersionPlan.next_patch_version;
  evidence.dry_run = dryRun === "true";
  evidence.local_plugin_package_previous_version = localPluginVersionPlan.package_previous_version;
  evidence.local_plugin_package_previous_version_raw = localPluginVersionPlan.package_previous_version.replace(/^v/, "");
  evidence.local_plugin_package_version = localPluginVersionPlan.package_version;
  evidence.local_plugin_package_version_raw = localPluginVersionPlan.package_version.replace(/^v/, "");
  evidence.local_plugin_package_version_changed = localPluginVersionPlan.package_version_changed;
  evidence.memos_release_notes = {
    source: releaseNotes.source,
    name: releaseNotes.name,
    repository_notes_file: releaseNotes.repository_notes_file,
    repository_notes_found: releaseNotes.repository_notes_found,
    body_preview: redact(releaseNotes.body).slice(0, 12000),
  };
  evidence.existing_tag = existingTag;

  const draft = await requestDocAgentDraft(evidence);
  const validation = validateDraft(draft, evidence);
  if (!validation.ok) fail(`Validated draft is not acceptable: ${JSON.stringify(validation.issues)}`);

  const preview = buildDocsPreview(draft, evidence);
  const outputRoot =
    process.env.INSPECTION_DIR ||
    join(tmpdir(), `memos-release-${currentTag.replace(/[^A-Za-z0-9_.-]/g, "-")}-inspection`);
  mkdirSync(outputRoot, { recursive: true });

  const releaseNotesFile = join(outputRoot, "memos-release-notes.md");
  const releaseNotesAliasFile = join(outputRoot, "release-notes.md");
  const evidenceFile = join(outputRoot, "local-plugin-evidence.json");
  const evidenceAliasFile = join(outputRoot, "evidence.json");
  const draftFile = join(outputRoot, "local-plugin-docs-draft.json");
  const docsPreviewFile = join(outputRoot, "local-plugin-docs-preview.json");
  const docsPreviewAliasFile = join(outputRoot, "docs-preview.json");
  const docsPreviewMarkdownFile = join(outputRoot, "local-plugin-docs-preview.md");
  const docsPreviewMarkdownAliasFile = join(outputRoot, "docs-preview.md");
  const qualityReportFile = join(outputRoot, "quality-report.json");
  const releaseIntentPreviewFile = join(outputRoot, "local-plugin-release-intent.json");
  const readmeFile = join(outputRoot, "README.md");

  writeFileSync(releaseNotesFile, `${releaseNotes.body.trim()}\n`, "utf8");
  writeFileSync(releaseNotesAliasFile, `${releaseNotes.body.trim()}\n`, "utf8");
  const redactedEvidence = JSON.parse(redact(JSON.stringify(evidence, null, 2)));
  const evidenceDigest = sha256Json(redactedEvidence);
  writeJson(evidenceFile, redactedEvidence);
  writeJson(evidenceAliasFile, redactedEvidence);
  writeJson(
    releaseIntentPreviewFile,
    buildLocalPluginReleaseIntent({
      enabled: Boolean(localPluginVersionPlan.release_requested),
      version: localPluginVersionPlan.expected_version,
      tag: localPluginVersionPlan.local_plugin_tag,
      sourceSha: localPluginVersionPlan.release_requested ? target.sha : "",
      evidenceDigest,
      memosReleaseTag: currentTag,
      pluginReleaseUrl: localPluginVersionPlan.release_requested
        ? `https://github.com/MemTensor/MemOS/releases/tag/${localPluginVersionPlan.local_plugin_tag}`
        : "",
    }),
  );
  writeJson(draftFile, draft);
  writeJson(docsPreviewFile, preview);
  writeJson(docsPreviewAliasFile, preview);
  writeFileSync(docsPreviewMarkdownFile, docsPreviewMarkdown(preview, draft, evidence), "utf8");
  writeFileSync(docsPreviewMarkdownAliasFile, docsPreviewMarkdown(preview, draft, evidence), "utf8");
  const qualityReport = {
    ok: validation.ok,
    source_id: PRODUCT_ID,
    release_kind: "memos_whole_repo",
    docs_product_extraction: "path_filtered",
    public_release_body: "github_generated_whats_changed",
    dry_run: dryRun === "true",
    release_notes_source: releaseNotes.source,
    current_tag: currentTag,
    previous_tag: previousTag,
    memos_release_tag: currentTag,
    memos_release_version: version,
    memos_project_version: evidence.memos_project_version,
    local_plugin_release_mode: localPluginReleaseMode,
    auto_post_merge_release: autoPostMergeRelease,
    create_draft_release: createDraftRelease,
    local_plugin_version: evidence.local_plugin_version,
    local_plugin_previous_version: evidence.local_plugin_previous_version,
    local_plugin_version_changed: evidence.local_plugin_version_changed,
    local_plugin_version_required: localPluginVersionPlan.version_required,
    local_plugin_version_source: evidence.local_plugin_version_source,
    local_plugin_version_auto_incremented: evidence.local_plugin_version_auto_incremented,
    local_plugin_version_input_ignored: evidence.local_plugin_version_input_ignored,
    local_plugin_version_input_ignored_reason: evidence.local_plugin_version_input_ignored_reason,
    local_plugin_expected_version: localPluginVersionPlan.expected_version,
    local_plugin_publish_version: localPluginVersionPlan.input_raw,
    local_plugin_release_requested: localPluginVersionPlan.release_requested,
    pending_local_plugin_changes: localPluginVersionPlan.pending_local_plugin_changes,
    local_plugin_tag: localPluginVersionPlan.local_plugin_tag,
    local_plugin_previous_tag: evidence.local_plugin_previous_tag,
    local_plugin_baseline: evidence.local_plugin_baseline,
    local_plugin_next_patch_version: localPluginVersionPlan.next_patch_version,
    local_plugin_tag_exists: localPluginVersionPlan.requested_tag_exists,
    local_plugin_npm_version_exists: localPluginVersionPlan.npm_version_exists,
    local_plugin_recovery_enabled: localPluginVersionPlan.recovery_enabled,
    evidence_digest: evidenceDigest,
    local_plugin_package_version: evidence.local_plugin_package_version,
    local_plugin_package_previous_version: evidence.local_plugin_package_previous_version,
    local_plugin_package_version_changed: evidence.local_plugin_package_version_changed,
    existing_tag: existingTag,
    publish_blocked: existingTag.publish_blocked,
    target_ref: target.ref,
    target_sha: target.sha,
    product_paths: evidence.product_paths,
    has_product_changes: evidence.has_product_changes,
    has_user_facing_product_changes: evidence.has_user_facing_product_changes,
    skip_reason: evidence.skip_reason,
    docs_action: preview.docs_action,
    changed_file_count: evidence.changed_files.length,
    commit_count: evidence.commits.length,
    important_commit_count: evidence.important_commits.length,
    release_item_count: draft.release_items.length,
    release_note_methodology: RELEASE_NOTE_METHODS,
    coverage: validation.coverage,
    validation_report: validation,
    validation_attempt_count: draft.validation_attempt_count,
    repair_attempt_count: draft.repair_attempt_count,
    warnings: draft.warnings,
    docs_preview_files: ["content/cn/plugin-changelog.yml", "content/en/plugin-changelog.yml"],
    no_side_effects: {
      npm_publish: false,
      oss_upload: false,
      production_docs_pr: false,
      pre_gray_production: false,
    },
  };
  writeJson(qualityReportFile, qualityReport);
  writeFileSync(
    readmeFile,
    [
      "# MemOS release inspection",
      "",
      `- source_id: ${PRODUCT_ID}`,
      "- release_kind: memos_whole_repo",
      "- docs_product_extraction: path_filtered",
      "- public_release_body: github_generated_whats_changed",
      `- dry_run: ${dryRun}`,
      `- current_tag: ${currentTag}`,
      `- previous_tag: ${previousTag}`,
      `- local_plugin_release_mode: ${localPluginReleaseMode}`,
      `- auto_post_merge_release: ${autoPostMergeRelease}`,
      `- create_draft_release: ${createDraftRelease}`,
      `- local_plugin_version: ${evidence.local_plugin_version}`,
      `- local_plugin_previous_version: ${evidence.local_plugin_previous_version}`,
      `- local_plugin_version_changed: ${evidence.local_plugin_version_changed}`,
      `- local_plugin_version_required: ${localPluginVersionPlan.version_required}`,
      `- local_plugin_version_source: ${evidence.local_plugin_version_source}`,
      `- local_plugin_version_auto_incremented: ${evidence.local_plugin_version_auto_incremented}`,
      `- local_plugin_version_input_ignored: ${evidence.local_plugin_version_input_ignored}`,
      `- local_plugin_version_input_ignored_reason: ${evidence.local_plugin_version_input_ignored_reason || "n/a"}`,
      `- local_plugin_expected_version: ${localPluginVersionPlan.expected_version || "n/a"}`,
      `- local_plugin_publish_version: ${localPluginVersionPlan.input_raw || "n/a"}`,
      `- local_plugin_release_requested: ${localPluginVersionPlan.release_requested}`,
      `- pending_local_plugin_changes: ${localPluginVersionPlan.pending_local_plugin_changes}`,
      `- local_plugin_tag: ${localPluginVersionPlan.local_plugin_tag || "n/a"}`,
      `- local_plugin_previous_tag: ${evidence.local_plugin_previous_tag}`,
      `- local_plugin_next_patch_version: ${localPluginVersionPlan.next_patch_version}`,
      `- local_plugin_tag_exists: ${localPluginVersionPlan.requested_tag_exists}`,
      `- local_plugin_npm_version_exists: ${localPluginVersionPlan.npm_version_exists}`,
      `- local_plugin_recovery_enabled: ${localPluginVersionPlan.recovery_enabled}`,
      `- evidence_digest: ${evidenceDigest}`,
      `- local_plugin_package_version: ${evidence.local_plugin_package_version}`,
      `- local_plugin_package_previous_version: ${evidence.local_plugin_package_previous_version}`,
      `- local_plugin_package_version_changed: ${evidence.local_plugin_package_version_changed}`,
      `- existing_tag_status: ${existingTag.status}`,
      `- existing_tag_sha: ${existingTag.tag_sha || "n/a"}`,
      `- publish_blocked: ${existingTag.publish_blocked}`,
      `- target_ref: ${target.ref}`,
      `- target_sha: ${target.sha}`,
      `- product_paths: ${evidence.product_paths.join(", ")}`,
      `- release_notes_source: ${releaseNotes.source}`,
      `- has_product_changes: ${evidence.has_product_changes}`,
      `- has_user_facing_product_changes: ${evidence.has_user_facing_product_changes}`,
      `- docs_action: ${preview.docs_action}`,
      `- skip_reason: ${evidence.skip_reason || "n/a"}`,
      `- validation_attempt_count: ${draft.validation_attempt_count}`,
      `- repair_attempt_count: ${draft.repair_attempt_count}`,
      "- no_side_effects: npm_publish=false, oss_upload=false, production_docs_pr=false, pre_gray_production=false",
      "",
      "Files:",
      "",
      "- memos-release-notes.md",
      "- release-notes.md",
      "- local-plugin-evidence.json",
      "- evidence.json",
      "- local-plugin-docs-draft.json",
      "- local-plugin-docs-preview.md",
      "- local-plugin-docs-preview.json",
      "- docs-preview.md",
      "- docs-preview.json",
      "- quality-report.json",
      "- local-plugin-release-intent.json",
      "",
    ].join("\n"),
    "utf8",
  );

  appendOutput("inspection_dir", outputRoot);
  appendOutput("memos_release_notes_file", releaseNotesFile);
  appendOutput("release_notes_file", releaseNotesFile);
  appendOutput("evidence_file", evidenceFile);
  appendOutput("docs_preview_file", docsPreviewFile);
  appendOutput("docs_preview_markdown_file", docsPreviewMarkdownFile);
  appendOutput("quality_report_file", qualityReportFile);
  appendOutput("release_intent_preview_file", releaseIntentPreviewFile);
  appendOutput("evidence_digest", evidenceDigest);
  appendOutput("source_id", PRODUCT_ID);
  appendOutput("release_version", version);
  appendOutput("dry_run", String(dryRun === "true"));
  appendOutput("create_draft_release", String(createDraftRelease));
  appendOutput("auto_post_merge_release", String(autoPostMergeRelease));
  appendOutput("local_plugin_release_mode", localPluginReleaseMode);
  appendOutput("previous_tag", previousTag);
  appendOutput("current_tag", currentTag);
  appendOutput("local_plugin_version", evidence.local_plugin_version);
  appendOutput("local_plugin_previous_version", evidence.local_plugin_previous_version);
  appendOutput("local_plugin_version_changed", String(evidence.local_plugin_version_changed));
  appendOutput("local_plugin_version_required", String(localPluginVersionPlan.version_required));
  appendOutput("local_plugin_version_source", evidence.local_plugin_version_source);
  appendOutput("local_plugin_version_auto_incremented", String(evidence.local_plugin_version_auto_incremented));
  appendOutput("local_plugin_version_input_ignored", String(evidence.local_plugin_version_input_ignored));
  appendOutput("local_plugin_version_input_ignored_reason", evidence.local_plugin_version_input_ignored_reason || "");
  appendOutput("local_plugin_expected_version", localPluginVersionPlan.expected_version || "");
  appendOutput("local_plugin_publish_version", localPluginVersionPlan.input_raw || "");
  appendOutput("local_plugin_release_requested", String(localPluginVersionPlan.release_requested));
  appendOutput("pending_local_plugin_changes", String(localPluginVersionPlan.pending_local_plugin_changes));
  appendOutput("local_plugin_tag", localPluginVersionPlan.local_plugin_tag || "");
  appendOutput("local_plugin_previous_tag", evidence.local_plugin_previous_tag || "");
  appendOutput("local_plugin_next_patch_version", localPluginVersionPlan.next_patch_version || "");
  appendOutput("local_plugin_tag_exists", String(localPluginVersionPlan.requested_tag_exists));
  appendOutput("local_plugin_npm_version_exists", String(localPluginVersionPlan.npm_version_exists));
  appendOutput("local_plugin_recovery_enabled", String(localPluginVersionPlan.recovery_enabled));
  appendOutput("local_plugin_package_version", evidence.local_plugin_package_version);
  appendOutput("local_plugin_package_previous_version", evidence.local_plugin_package_previous_version);
  appendOutput("local_plugin_package_version_changed", String(evidence.local_plugin_package_version_changed));
  appendOutput("existing_tag_status", existingTag.status);
  appendOutput("existing_tag_sha", existingTag.tag_sha || "");
  appendOutput("publish_blocked", String(existingTag.publish_blocked));
  appendOutput("publish_block_reason", existingTag.publish_blocked ? existingTag.message : "");
  appendOutput("target_ref", target.ref);
  appendOutput("target_sha", target.sha);
  appendOutput("memos_package_version", memosPackageVersion.version);
  appendOutput("has_product_changes", String(evidence.has_product_changes));
  appendOutput("has_user_facing_product_changes", String(evidence.has_user_facing_product_changes));
  appendOutput("docs_action", preview.docs_action);
  appendOutput("skip_reason", evidence.skip_reason || "");
  appendOutput("release_notes_source", releaseNotes.source);
  appendOutput("validation_attempt_count", String(draft.validation_attempt_count ?? ""));
  appendOutput("repair_attempt_count", String(draft.repair_attempt_count ?? ""));

  console.log(`Prepared MemOS release inspection in ${outputRoot}`);
  console.log(`Release notes source: ${releaseNotes.source}`);
  console.log(`Range: ${previousTag}..${target.sha}`);
  console.log(`MemOS local plugin version: ${evidence.local_plugin_previous_version} -> ${evidence.local_plugin_version}`);
  console.log(`MemOS local plugin changed files: ${evidence.changed_files.length}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(`::error::${redact(error?.stack || error?.message || error)}`);
    process.exit(1);
  });
}
