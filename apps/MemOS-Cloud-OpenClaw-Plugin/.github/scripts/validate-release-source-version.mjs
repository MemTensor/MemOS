import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const RELEASE_VERSION_FILES = [
  "package.json",
  "openclaw.plugin.json",
  "moltbot.plugin.json",
  "clawdbot.plugin.json",
];

function clean(value) {
  return String(value ?? "").trim();
}

function readJsonAtRef(file, sourceRef) {
  const raw =
    sourceRef === "WORKTREE"
      ? readFileSync(file, "utf8")
      : execFileSync("git", ["show", `${sourceRef}:${file}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
  return JSON.parse(raw);
}

export function inspectReleaseSourceVersion({
  expectedVersion,
  sourceRef = "HEAD",
  files = RELEASE_VERSION_FILES,
} = {}) {
  const expected = clean(expectedVersion);
  const ref = clean(sourceRef) || "HEAD";
  if (!expected) {
    throw new Error("RELEASE_VERSION is required.");
  }

  const versions = [];
  for (const file of files) {
    try {
      const value = readJsonAtRef(file, ref);
      versions.push({
        file,
        version: clean(value?.version),
        ok: clean(value?.version) === expected,
        error: "",
      });
    } catch (error) {
      versions.push({
        file,
        version: "",
        ok: false,
        error: clean(error?.message || error),
      });
    }
  }

  const mismatches = versions.filter((entry) => !entry.ok);
  return {
    ok: mismatches.length === 0,
    expected_version: expected,
    source_ref: ref,
    versions,
    mismatches,
  };
}

export function formatReleaseSourceVersionError(report) {
  const lines = [
    `Release source ${report.source_ref} is not ready for version ${report.expected_version}.`,
    "The publish workflow only consumes committed versions; it does not modify source files or create a version PR.",
  ];
  for (const entry of report.mismatches) {
    const actual = entry.version || (entry.error ? "unreadable" : "missing");
    lines.push(`- ${entry.file}: expected ${report.expected_version}, got ${actual}`);
  }
  lines.push(
    "Update all four version files in a normal reviewed PR, merge it to main, then rerun the dry-run.",
  );
  return lines.join("\n");
}

export function run() {
  const report = inspectReleaseSourceVersion({
    expectedVersion: process.env.RELEASE_VERSION,
    sourceRef: process.env.RELEASE_SOURCE_REF || "HEAD",
  });
  if (!report.ok) {
    console.error(`::error::${formatReleaseSourceVersionError(report)}`);
    process.exitCode = 1;
    return report;
  }

  console.log(
    `Validated ${report.expected_version} in ${RELEASE_VERSION_FILES.length} committed version files at ${report.source_ref}.`,
  );
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
