#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compareSemver, parseSemver } from "../../lib/semver.js";

export const VERSION_FILES = [
  "package.json",
  "openclaw.plugin.json",
  "moltbot.plugin.json",
  "clawdbot.plugin.json",
];

function clean(value) {
  return String(value ?? "").trim();
}

function exactSha(value) {
  return /^[0-9a-fA-F]{40}$/.test(clean(value));
}

export function npmDistTagForVersion(version) {
  const parsed = parseSemver(version);
  if (!parsed) throw new Error(`version must be valid SemVer; got '${clean(version)}'`);
  if (parsed.prerelease.length === 0) return "latest";
  const identifier = String(parsed.prerelease[0] || "").toLowerCase();
  return ["alpha", "beta", "next"].includes(identifier) ? identifier : "next";
}

export function versionsFromFiles(root = process.cwd()) {
  return Object.fromEntries(
    VERSION_FILES.map((file) => {
      const payload = JSON.parse(readFileSync(join(root, file), "utf8"));
      return [file, clean(payload.version)];
    }),
  );
}

export function versionsFromGitRef(ref, root = process.cwd()) {
  const sourceRef = clean(ref);
  if (!sourceRef) throw new Error("a git ref is required to read previous versions");
  return Object.fromEntries(
    VERSION_FILES.map((file) => {
      const raw = execFileSync("git", ["show", `${sourceRef}:${file}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return [file, clean(JSON.parse(raw).version)];
    }),
  );
}

function changedVersionFiles(previousVersions, currentVersions) {
  return VERSION_FILES.filter(
    (file) => clean(previousVersions?.[file]) !== clean(currentVersions?.[file]),
  );
}

function commonVersion(versions, label) {
  const values = VERSION_FILES.map((file) => clean(versions?.[file]));
  const missing = VERSION_FILES.filter((_, index) => !values[index]);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `${label} is missing version values in ${missing.join(", ")}`,
    };
  }
  const unique = [...new Set(values)];
  if (unique.length !== 1) {
    return {
      ok: false,
      reason: `${label} has inconsistent versions: ${VERSION_FILES.map((file) => `${file}=${clean(versions?.[file]) || "missing"}`).join(", ")}`,
    };
  }
  return { ok: true, version: unique[0] };
}

export function inspectVersionTransition({ previousVersions, currentVersions }) {
  const changedFiles = changedVersionFiles(previousVersions, currentVersions);
  if (changedFiles.length === 0) {
    return {
      ok: true,
      eligible: false,
      reason: "the merge did not change any release version value",
      changed_version_files: [],
    };
  }

  const previous = commonVersion(previousVersions, "the pre-merge main source");
  if (!previous.ok) return { ...previous, eligible: false, changed_version_files: changedFiles };
  if (changedFiles.length !== VERSION_FILES.length) {
    const unchanged = VERSION_FILES.filter((file) => !changedFiles.includes(file));
    return {
      ok: false,
      eligible: false,
      reason: `a release version changed, but all four version files were not updated; unchanged: ${unchanged.join(", ")}`,
      previous_version: previous.version,
      version: "",
      changed_version_files: changedFiles,
    };
  }
  const current = commonVersion(currentVersions, "the merged main source");
  if (!current.ok) return { ...current, eligible: false, changed_version_files: changedFiles };
  if (!parseSemver(previous.version) || !parseSemver(current.version)) {
    return {
      ok: false,
      eligible: false,
      reason: `release versions must be strict SemVer; got ${previous.version} -> ${current.version}`,
      previous_version: previous.version,
      version: current.version,
      changed_version_files: changedFiles,
    };
  }
  if (previous.version.includes("+") || current.version.includes("+")) {
    return {
      ok: false,
      eligible: false,
      reason: "automatic releases reject SemVer build metadata because npm precedence and immutable v-tags would become ambiguous",
      previous_version: previous.version,
      version: current.version,
      changed_version_files: changedFiles,
    };
  }
  if (compareSemver(current.version, previous.version) <= 0) {
    return {
      ok: false,
      eligible: false,
      reason: `release version must increase by SemVer precedence; got ${previous.version} -> ${current.version}`,
      previous_version: previous.version,
      version: current.version,
      changed_version_files: changedFiles,
    };
  }

  return {
    ok: true,
    eligible: true,
    reason: `all four committed versions increased from ${previous.version} to ${current.version}`,
    previous_version: previous.version,
    version: current.version,
    npm_dist_tag: npmDistTagForVersion(current.version),
    github_release_prerelease: parseSemver(current.version).prerelease.length > 0,
    release_notes_path: `.github/release-notes/v${current.version}.md`,
    changed_version_files: changedFiles,
  };
}

export function inspectPullRequestEvent({
  eventName,
  merged,
  baseRef,
  headRepo,
  repository,
  mergeSha,
  baseSha,
}) {
  if (eventName !== "pull_request") {
    return { ok: true, inspect: false, reason: "manual workflow dispatch" };
  }
  if (clean(merged).toLowerCase() !== "true") {
    return { ok: true, inspect: false, reason: "pull request closed without merge" };
  }
  if (baseRef !== "main") {
    return { ok: true, inspect: false, reason: `pull request targets ${baseRef || "an unknown branch"}, not main` };
  }
  if (headRepo !== repository) {
    return { ok: true, inspect: false, reason: "fork pull requests cannot authorize an automatic release" };
  }
  if (!exactSha(mergeSha) || !exactSha(baseSha)) {
    return {
      ok: false,
      inspect: false,
      reason: "merged PR must provide exact 40-character base and merge commit SHAs",
    };
  }
  return { ok: true, inspect: true, reason: "same-repository PR merged into main" };
}

export function validateAutoRelease({
  eventName,
  merged,
  baseRef,
  headRepo,
  repository,
  mergeSha,
  baseSha,
  previousVersions,
  currentVersions,
}) {
  const event = inspectPullRequestEvent({
    eventName,
    merged,
    baseRef,
    headRepo,
    repository,
    mergeSha,
    baseSha,
  });
  if (!event.ok || !event.inspect) return { ...event, eligible: false };
  const transition = inspectVersionTransition({ previousVersions, currentVersions });
  return {
    ...transition,
    inspect: true,
    target_sha: clean(mergeSha),
    base_sha: clean(baseSha),
  };
}

function writeOutputs(result, outputFile) {
  if (!outputFile) return;
  appendFileSync(
    outputFile,
    [
      `eligible=${result.eligible === true}`,
      `reason=${clean(result.reason).replaceAll("\n", " ")}`,
      `previous_version=${result.previous_version || ""}`,
      `version=${result.version || ""}`,
      `npm_dist_tag=${result.npm_dist_tag || ""}`,
      `github_release_prerelease=${result.github_release_prerelease === true}`,
      `target_sha=${result.target_sha || ""}`,
      `base_sha=${result.base_sha || ""}`,
      `release_notes_path=${result.release_notes_path || ""}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

export function main(env = process.env) {
  const event = inspectPullRequestEvent({
    eventName: env.EVENT_NAME,
    merged: env.PR_MERGED,
    baseRef: env.PR_BASE_REF,
    headRepo: env.PR_HEAD_REPO,
    repository: env.GITHUB_REPOSITORY,
    mergeSha: env.PR_MERGE_SHA,
    baseSha: env.PR_BASE_SHA,
  });
  if (!event.ok || !event.inspect) {
    const result = { ...event, eligible: false };
    writeOutputs(result, env.GITHUB_OUTPUT);
    if (!result.ok) throw new Error(result.reason);
    console.log(`Automatic release skipped: ${result.reason}`);
    return result;
  }
  const root = env.GITHUB_WORKSPACE || process.cwd();
  const currentVersions = versionsFromGitRef(env.PR_MERGE_SHA, root);
  const previousVersions = versionsFromGitRef(env.PR_BASE_SHA, root);
  const result = validateAutoRelease({
    eventName: env.EVENT_NAME,
    merged: env.PR_MERGED,
    baseRef: env.PR_BASE_REF,
    headRepo: env.PR_HEAD_REPO,
    repository: env.GITHUB_REPOSITORY,
    mergeSha: env.PR_MERGE_SHA,
    baseSha: env.PR_BASE_SHA,
    previousVersions,
    currentVersions,
  });
  writeOutputs(result, env.GITHUB_OUTPUT);
  if (!result.ok) throw new Error(result.reason);
  console.log(
    result.eligible
      ? `Automatic release accepted: ${result.previous_version} -> ${result.version}, npm tag=${result.npm_dist_tag}, target=${result.target_sha}`
      : `Automatic release skipped: ${result.reason}`,
  );
  return result;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}
