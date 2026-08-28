#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { parseLocalPluginReleaseIntent } from "./append-local-plugin-release-intent.mjs";
import {
  canonicalJson,
  parseLocalPluginReleaseBinding,
} from "./local-plugin-release-contract.mjs";

const MEMOS_RELEASE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  throw new Error(String(message));
}

function ghJson(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim().slice(0, 1000);
    fail(`gh ${args.slice(0, 4).join(" ")} failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`gh ${args.slice(0, 4).join(" ")} returned invalid JSON`);
  }
}

function output(values) {
  const outputFile = String(process.env.GITHUB_OUTPUT || "").trim();
  if (!outputFile) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join("\n");
  appendFileSync(outputFile, `${lines}\n`, "utf8");
}

function outputForIntent(status, memosRelease, intent) {
  output({
    status,
    memos_release_tag: memosRelease.tag,
    memos_release_version: memosRelease.tag.replace(/^v/, ""),
    local_plugin_tag: intent?.tag || "",
    local_plugin_version: intent?.version?.replace(/^v/, "") || "",
    local_plugin_source_sha: intent?.source_sha || "",
  });
}

function normalizeRelease(raw) {
  return {
    id: Number(raw?.id || 0),
    tag: String(raw?.tag_name || ""),
    name: String(raw?.name || ""),
    body: String(raw?.body || ""),
    draft: Boolean(raw?.draft),
    prerelease: Boolean(raw?.prerelease),
    publishedAt: String(raw?.published_at || ""),
    url: String(raw?.html_url || ""),
  };
}

function assertBindingMatchesIntent(binding, intent, memosReleaseTag) {
  const expected = {
    schema: "memos.local-plugin.github-release-binding.v1",
    version: intent.version,
    tag: intent.tag,
    source_sha: intent.source_sha,
    evidence_digest: intent.evidence_digest,
    origin_mode: "memos_weekly",
    memos_release_tag: memosReleaseTag,
    prerelease: false,
    docs_trigger: "local_plugin_release_published",
  };
  if (canonicalJson(binding) !== canonicalJson(expected)) {
    fail("paired local-plugin GitHub Release binding does not match the MemOS Release intent");
  }
}

export function validatePair({
  memosRelease,
  pluginRelease,
  pluginTagSha,
  pluginTagParentShas = [],
  memosTagSha = "",
}) {
  if (!MEMOS_RELEASE_TAG_RE.test(memosRelease.tag)) {
    fail(`paired publisher only accepts stable MemOS v* Releases; received ${memosRelease.tag || "<empty>"}`);
  }
  if (memosRelease.draft || memosRelease.prerelease) {
    fail(`MemOS Release ${memosRelease.tag} must be published and non-prerelease`);
  }
  const memosPublishedAt = Date.parse(String(memosRelease.publishedAt || ""));
  if (!Number.isFinite(memosPublishedAt)) {
    fail(`MemOS Release ${memosRelease.tag} must have a valid published_at timestamp`);
  }
  const intent = parseLocalPluginReleaseIntent(memosRelease.body);
  if (intent.memos_release_tag !== memosRelease.tag) {
    fail(`MemOS Release intent is bound to ${intent.memos_release_tag}, not ${memosRelease.tag}`);
  }
  if (!intent.enabled) return { enabled: false, intent };
  if (!intent.paired_release || intent.docs_trigger !== "local_plugin_release_published") {
    fail("enabled MemOS local-plugin intent must use the paired local-plugin release.published trigger");
  }
  const expectedUrl = `https://github.com/MemTensor/MemOS/releases/tag/${intent.tag}`;
  if (intent.plugin_release_url !== expectedUrl) {
    fail(`MemOS Release intent plugin URL must equal ${expectedUrl}`);
  }
  if (pluginTagSha !== intent.source_sha) {
    fail(`local-plugin tag ${intent.tag} points to ${pluginTagSha || "<missing>"}, expected ${intent.source_sha}`);
  }
  if (!/^[0-9a-f]{40}$/.test(memosTagSha)) {
    fail(`MemOS tag ${memosRelease.tag} did not resolve to a commit`);
  }
  const parentShas = new Set(pluginTagParentShas.map((sha) => String(sha || "")));
  if (pluginTagSha !== memosTagSha && !parentShas.has(memosTagSha)) {
    fail(
      `local-plugin tag ${intent.tag} is not based on MemOS Release ${memosRelease.tag}: ` +
        `plugin tag ${pluginTagSha}, MemOS tag ${memosTagSha}`,
    );
  }
  if (!pluginRelease || pluginRelease.tag !== intent.tag) {
    fail(`paired local-plugin GitHub Release ${intent.tag} does not exist or returned a different tag`);
  }
  if (pluginRelease.prerelease) {
    fail(`paired stable local-plugin GitHub Release ${intent.tag} must not be a prerelease`);
  }
  if (pluginRelease.name !== `MemOS Local Plugin ${intent.version}`) {
    fail(`paired local-plugin GitHub Release ${intent.tag} has an unexpected title`);
  }
  if (pluginRelease.url !== expectedUrl) {
    fail(`paired local-plugin GitHub Release URL does not match ${expectedUrl}`);
  }
  const binding = parseLocalPluginReleaseBinding(pluginRelease.body);
  assertBindingMatchesIntent(binding, intent, memosRelease.tag);
  if (!pluginRelease.draft) {
    const pluginPublishedAt = Date.parse(String(pluginRelease.publishedAt || ""));
    if (!Number.isFinite(pluginPublishedAt)) {
      fail(`published local-plugin GitHub Release ${intent.tag} must have a valid published_at timestamp`);
    }
    if (pluginPublishedAt < memosPublishedAt) {
      fail(
        `local-plugin GitHub Release ${intent.tag} was published before its paired MemOS Release; ` +
          "the docs webhook must be recovered explicitly",
      );
    }
  }
  return { enabled: true, intent, binding, alreadyPublished: !pluginRelease.draft };
}

function loadMemOSRelease(repo) {
  const override = String(process.env.MEMOS_RELEASE_TAG_OVERRIDE || "").trim();
  if (override) {
    return normalizeRelease(ghJson(["api", `repos/${repo}/releases/tags/${override}`]));
  }
  const eventFile = String(process.env.GITHUB_EVENT_PATH || "").trim();
  if (!eventFile) fail("GITHUB_EVENT_PATH or MEMOS_RELEASE_TAG_OVERRIDE is required");
  const event = JSON.parse(readFileSync(eventFile, "utf8"));
  if (event.action !== "published") fail(`paired publisher requires release.published; received ${event.action || "<empty>"}`);
  return normalizeRelease(event.release);
}

export function main() {
  const repo = String(process.env.GITHUB_REPOSITORY || "").trim();
  if (repo !== "MemTensor/MemOS") fail(`paired publisher is restricted to MemTensor/MemOS; received ${repo || "<empty>"}`);
  const validateOnly = String(process.env.VALIDATE_ONLY || "").trim() === "true";
  const memosRelease = loadMemOSRelease(repo);
  const intent = parseLocalPluginReleaseIntent(memosRelease.body);
  if (!intent.enabled) {
    validatePair({ memosRelease, pluginRelease: null, pluginTagSha: "" });
    outputForIntent("skipped", memosRelease, intent);
    console.log(`MemOS Release ${memosRelease.tag} has no paired local-plugin publish; nothing to do.`);
    return;
  }

  const tagCommit = ghJson(["api", `repos/${repo}/commits/${intent.tag}`]);
  const memosTagCommit = ghJson(["api", `repos/${repo}/commits/${memosRelease.tag}`]);
  const pluginTagParentShas = Array.isArray(tagCommit.parents)
    ? tagCommit.parents.map((parent) => String(parent?.sha || "")).filter(Boolean)
    : [];
  let pluginRelease = normalizeRelease(ghJson(["api", `repos/${repo}/releases/tags/${intent.tag}`]));
  const validated = validatePair({
    memosRelease,
    pluginRelease,
    pluginTagSha: String(tagCommit.sha || ""),
    pluginTagParentShas,
    memosTagSha: String(memosTagCommit.sha || ""),
  });
  if (validated.alreadyPublished) {
    outputForIntent("already_published", memosRelease, intent);
    console.log(`Paired local-plugin GitHub Release ${intent.tag} is already published and matches the MemOS intent.`);
    return;
  }
  if (validateOnly) {
    outputForIntent("staged", memosRelease, intent);
    console.log(`Paired local-plugin GitHub Release ${intent.tag} is staged and ready for npm publish.`);
    return;
  }

  ghJson([
    "api",
    "--method",
    "PATCH",
    `repos/${repo}/releases/${pluginRelease.id}`,
    "-F",
    "draft=false",
    "-F",
    "prerelease=false",
    "-f",
    "make_latest=false",
  ]);
  pluginRelease = normalizeRelease(ghJson(["api", `repos/${repo}/releases/tags/${intent.tag}`]));
  const after = validatePair({
    memosRelease,
    pluginRelease,
    pluginTagSha: String(tagCommit.sha || ""),
    pluginTagParentShas,
    memosTagSha: String(memosTagCommit.sha || ""),
  });
  if (!after.alreadyPublished) fail(`paired local-plugin GitHub Release ${intent.tag} remained a Draft after publish`);
  outputForIntent("published", memosRelease, intent);
  console.log(`Published paired local-plugin GitHub Release ${intent.tag}; its release.published webhook is the docs trigger.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
