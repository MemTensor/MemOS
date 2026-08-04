import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ALLOWED_DIST_TAGS = new Set(["latest", "beta", "next", "alpha"]);

export function validateVersionChannel(version, distTag) {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(`version must be valid SemVer without a leading v; received ${version}`);
  }
  const prereleaseIdentifiers = (match[4] || "").split(".").filter(Boolean);
  if (
    prereleaseIdentifiers.some(
      (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"),
    )
  ) {
    throw new Error(`numeric prerelease identifiers must not contain leading zeroes; received ${version}`);
  }
  if (!ALLOWED_DIST_TAGS.has(distTag)) {
    throw new Error(`npm dist-tag must be one of latest, beta, next, or alpha; received ${distTag}`);
  }

  const prerelease = match[4] || "";
  if (!prerelease && distTag !== "latest") {
    throw new Error(`stable version ${version} must use npm dist-tag latest`);
  }
  if (prerelease && distTag === "latest") {
    throw new Error(`prerelease version ${version} must not use npm dist-tag latest`);
  }

  const prereleaseChannel = prerelease.split(".")[0];
  if (["beta", "alpha", "next"].includes(prereleaseChannel) && prereleaseChannel !== distTag) {
    throw new Error(
      `prerelease channel ${prereleaseChannel} must match npm dist-tag ${prereleaseChannel}`,
    );
  }
  if (prerelease && !["beta", "alpha", "next"].includes(prereleaseChannel) && distTag !== "next") {
    throw new Error(
      `unrecognized prerelease channel ${prereleaseChannel} must use npm dist-tag next`,
    );
  }

  return { prerelease: Boolean(prerelease), prereleaseChannel };
}

export function classifyReleaseState({ tagExists }) {
  return tagExists ? "complete" : "fresh";
}

export function validateExistingTagVersions(
  { packageVersion, manifestVersion },
  { releaseTag, expectedVersion },
) {
  if (packageVersion !== expectedVersion) {
    throw new Error(
      `tag ${releaseTag} contains package version ${packageVersion}, expected ${expectedVersion}`,
    );
  }
  if (manifestVersion !== expectedVersion) {
    throw new Error(
      `tag ${releaseTag} contains Hermes manifest version ${manifestVersion || "<missing>"}, expected ${expectedVersion}`,
    );
  }
}

export function validateExistingTagSource(
  { tagCommit, parentCommits, changedFiles },
  { releaseTag, expectedSourceSha },
) {
  if (tagCommit === expectedSourceSha) {
    return;
  }
  if (parentCommits.length !== 1 || parentCommits[0] !== expectedSourceSha) {
    throw new Error(
      `tag ${releaseTag} does not point to the selected package source or its direct release metadata commit`,
    );
  }
  const allowedMetadataFiles = new Set([
    "apps/memos-local-plugin/package.json",
    "apps/memos-local-plugin/package-lock.json",
    "apps/memos-local-plugin/adapters/hermes/plugin.yaml",
  ]);
  const unexpected = changedFiles.filter((file) => !allowedMetadataFiles.has(file));
  if (unexpected.length > 0) {
    throw new Error(
      `tag ${releaseTag} release commit changes non-metadata file ${unexpected[0]}`,
    );
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runWithRetry(command, args, { missingPattern, label }) {
  let lastResult;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    lastResult = result;
    if (result.status === 0) {
      return { exists: true, stdout: result.stdout.trim() };
    }
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (missingPattern.test(output)) {
      return { exists: false, stdout: "" };
    }
    if (attempt < 3) {
      console.log(`::notice::${label} failed on attempt ${attempt}/3; retrying.`);
      execFileSync("sleep", [String(attempt * 5)]);
    }
  }
  const detail = `${lastResult?.stdout || ""}\n${lastResult?.stderr || ""}`.trim().slice(0, 1200);
  throw new Error(`${label} failed after three attempts${detail ? `: ${detail}` : ""}`);
}

function inspectRemoteTag(releaseTag, version, expectedSourceSha) {
  const output = runWithRetry(
    "git",
    [
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${releaseTag}`,
      `refs/tags/${releaseTag}^{}`,
    ],
    { missingPattern: /this-pattern-never-matches/i, label: `remote tag lookup for ${releaseTag}` },
  ).stdout;
  if (!output) {
    return { exists: false, commit: "" };
  }

  const lines = output.split("\n").filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${releaseTag}^{}`));
  const direct = lines.find((line) => line.endsWith(`refs/tags/${releaseTag}`));
  const remoteCommit = (peeled || direct || "").split(/\s+/)[0];
  if (!remoteCommit) {
    throw new Error(`could not resolve remote tag ${releaseTag}`);
  }

  const inspectionRef = `refs/memos-release-inspection/${releaseTag}`;
  runWithRetry(
    "git",
    ["fetch", "--force", "--no-tags", "origin", `refs/tags/${releaseTag}:${inspectionRef}`],
    { missingPattern: /this-pattern-never-matches/i, label: `fetch release tag ${releaseTag}` },
  );
  const fetchedCommit = run("git", ["rev-parse", `${inspectionRef}^{commit}`]);
  if (fetchedCommit !== remoteCommit) {
    throw new Error(
      `remote tag ${releaseTag} changed while it was inspected (${remoteCommit} -> ${fetchedCommit})`,
    );
  }

  const packageJson = JSON.parse(
    run("git", ["show", `${inspectionRef}:apps/memos-local-plugin/package.json`]),
  );
  const hermesManifest = run("git", [
    "show",
    `${inspectionRef}:apps/memos-local-plugin/adapters/hermes/plugin.yaml`,
  ]);
  const manifestVersion = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(hermesManifest)?.[1] || "";
  validateExistingTagVersions(
    { packageVersion: packageJson.version, manifestVersion },
    { releaseTag, expectedVersion: version },
  );
  run("git", ["cat-file", "-e", `${expectedSourceSha}^{commit}`]);
  const commitLine = run("git", ["rev-list", "--parents", "-n", "1", fetchedCommit]);
  const [, ...parentCommits] = commitLine.split(/\s+/);
  const changedFiles = run("git", [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    fetchedCommit,
  ])
    .split("\n")
    .filter(Boolean);
  validateExistingTagSource(
    { tagCommit: fetchedCommit, parentCommits, changedFiles },
    { releaseTag, expectedSourceSha },
  );

  return { exists: true, commit: fetchedCommit };
}

export function main() {
  const version = process.env.RELEASE_VERSION || "";
  const releaseTag = process.env.RELEASE_TAG || "";
  const distTag = process.env.NPM_DIST_TAG || "";
  const expectedSourceSha = process.env.EXPECTED_PACKAGE_SOURCE_SHA || "";
  const outputFile = process.env.GITHUB_OUTPUT || "";

  if (!version || !releaseTag || !distTag || !expectedSourceSha) {
    throw new Error(
      "RELEASE_VERSION, RELEASE_TAG, NPM_DIST_TAG, and EXPECTED_PACKAGE_SOURCE_SHA are required",
    );
  }
  if (releaseTag !== `memos-local-plugin-v${version}`) {
    throw new Error(`release tag ${releaseTag} does not match version ${version}`);
  }
  validateVersionChannel(version, distTag);

  const tag = inspectRemoteTag(releaseTag, version, expectedSourceSha);
  const state = classifyReleaseState({ tagExists: tag.exists });
  console.log(`Standalone package tag state: ${state}`);
  if (tag.commit) {
    console.log(`Existing release tag commit: ${tag.commit}`);
  }
  if (outputFile) {
    appendFileSync(outputFile, `state=${state}\ntag_commit=${tag.commit}\n`, "utf8");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
