#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  appendLocalPluginReleaseBinding,
  buildLocalPluginReleaseBinding,
  sha256Json,
  validateExistingLocalPluginRelease,
} from "./local-plugin-release-contract.mjs";

function fail(message) {
  throw new Error(String(message));
}

function sleep(seconds) {
  execFileSync("sleep", [String(seconds)]);
}

function gh(args) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function releaseView(repo, tag, { waitForVisibility = false } = {}) {
  const attempts = waitForVisibility ? 6 : 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = gh([
      "release",
      "view",
      tag,
      "--repo",
      repo,
      "--json",
      "body,isDraft,isPrerelease,name,tagName,targetCommitish,url",
    ]);
    if (result.status === 0) {
      try {
        return JSON.parse(result.stdout);
      } catch {
        fail(`GitHub Release ${tag} lookup returned invalid JSON`);
      }
    }
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    const missing = /release not found|HTTP 404|not found/i.test(detail);
    if (missing && !waitForVisibility) return null;
    if (attempt === attempts) {
      fail(
        waitForVisibility
          ? `GitHub Release ${tag} was created but did not become visible in time`
          : `GitHub Release ${tag} lookup failed after ${attempts} attempts: ${detail.slice(0, 800)}`,
      );
    }
    console.log(`::notice::GitHub Release ${tag} is not visible yet; retrying.`);
    sleep(Math.min(attempt * 5, 30));
  }
  return null;
}

function assertPublishedReleaseIsNotLatest(repo, tag, isDraft) {
  if (isDraft) return;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = gh(["api", `repos/${repo}/releases/latest`]);
    if (result.status === 0) {
      let latest;
      try {
        latest = JSON.parse(result.stdout);
      } catch {
        fail("GitHub latest Release lookup returned invalid JSON");
      }
      if (String(latest.tag_name || "") === tag) {
        fail(`GitHub Release ${tag} unexpectedly replaced the MemOS whole-repo Latest Release`);
      }
      return;
    }
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    if (/HTTP 404|not found/i.test(detail)) return;
    if (attempt === 3) fail(`GitHub latest Release lookup failed: ${detail.slice(0, 800)}`);
    sleep(attempt * 5);
  }
}

function writeOutputs(values) {
  const outputFile = String(process.env.GITHUB_OUTPUT || "").trim();
  if (!outputFile) return;
  appendFileSync(
    outputFile,
    Object.entries(values)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("\n") + "\n",
    "utf8",
  );
}

export function validateRelease(release, contract) {
  return validateExistingLocalPluginRelease(release, {
    expectedBody: contract.body,
    expectedBinding: contract.binding,
    expectedDraft: contract.createDraft,
    allowAlreadyPublished: !contract.createDraft,
  });
}

export function buildReleaseContract({
  version,
  tag,
  tagSha,
  notes,
  evidence,
  expectedEvidenceDigest = "",
  originMode,
  memosReleaseTag = "",
  createDraft = false,
}) {
  const evidenceDigest = sha256Json(evidence);
  if (expectedEvidenceDigest && expectedEvidenceDigest !== evidenceDigest) {
    fail(
      `local-plugin evidence digest mismatch: expected ${expectedEvidenceDigest}, calculated ${evidenceDigest}`,
    );
  }
  const binding = buildLocalPluginReleaseBinding({
    version,
    tag,
    sourceSha: tagSha,
    evidenceDigest,
    originMode,
    memosReleaseTag,
  });
  return {
    binding,
    body: appendLocalPluginReleaseBinding(notes, binding),
    createDraft: Boolean(createDraft),
    originMode,
    evidenceDigest,
  };
}

export function main() {
  const repo = String(process.env.GITHUB_REPOSITORY || "").trim();
  const version = String(process.env.RELEASE_VERSION || "").trim();
  const tag = String(process.env.RELEASE_TAG || "").trim();
  const tagSha = String(process.env.RELEASE_TAG_SHA || "").trim();
  const notesFile = String(process.env.RELEASE_NOTES_FILE || "").trim();
  const evidenceFile = String(process.env.EVIDENCE_FILE || "").trim();
  const originMode = String(process.env.RELEASE_ORIGIN_MODE || "").trim();
  const memosReleaseTag = String(process.env.MEMOS_RELEASE_TAG || "").trim();
  const createDraft = String(process.env.CREATE_DRAFT_RELEASE || "").trim() === "true";
  if (!repo || !notesFile || !evidenceFile) {
    fail("GITHUB_REPOSITORY, RELEASE_NOTES_FILE, and EVIDENCE_FILE are required");
  }

  const contract = buildReleaseContract({
    version,
    tag,
    tagSha,
    notes: readFileSync(notesFile, "utf8"),
    evidence: JSON.parse(readFileSync(evidenceFile, "utf8")),
    expectedEvidenceDigest: String(process.env.EXPECTED_EVIDENCE_DIGEST || "").trim(),
    originMode,
    memosReleaseTag,
    createDraft,
  });
  const bodyFile =
    String(process.env.OUTPUT_RELEASE_BODY_FILE || "").trim() ||
    join(String(process.env.RUNNER_TEMP || "/tmp"), `${tag}-release-body.md`);
  writeFileSync(bodyFile, contract.body, "utf8");

  let release = releaseView(repo, tag);
  if (!release) {
    const args = [
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--verify-tag",
      "--title",
      `MemOS Local Plugin ${contract.binding.version}`,
      "--notes-file",
      bodyFile,
      "--latest=false",
    ];
    if (contract.binding.prerelease) args.push("--prerelease");
    if (createDraft) args.push("--draft");

    let created = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = gh(args);
      if (result.status === 0) {
        created = true;
        break;
      }
      release = releaseView(repo, tag);
      if (release) {
        console.log(`::notice::GitHub Release ${tag} exists after a failed create response; validating it.`);
        break;
      }
      const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim().slice(0, 800);
      if (attempt === 3) fail(`failed to create GitHub Release ${tag}: ${detail}`);
      console.log(`::notice::GitHub Release ${tag} create failed on attempt ${attempt}/3; retrying.`);
      sleep(attempt * 5);
    }
    if (created) release = releaseView(repo, tag, { waitForVisibility: true });
  }

  const status = validateRelease(release, contract);
  assertPublishedReleaseIsNotLatest(repo, tag, Boolean(release.isDraft));
  writeOutputs({
    release_url: status.url,
    release_is_draft: Boolean(release.isDraft),
    release_already_published: status.alreadyPublished,
    release_body_file: bodyFile,
    evidence_digest: contract.evidenceDigest,
  });
  console.log(
    `Validated local-plugin GitHub Release ${tag} (draft=${Boolean(release.isDraft)}, prerelease=${Boolean(release.isPrerelease)}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
