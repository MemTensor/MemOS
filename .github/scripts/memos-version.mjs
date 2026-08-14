#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MEMOS_PYPROJECT_PATH = "pyproject.toml";
export const MEMOS_PACKAGE_INIT_PATH = "src/memos/__init__.py";

const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PYPROJECT_SECTION_RE = /^\[project\][ \t]*$/gm;
const TOML_SECTION_RE = /^\[\[?[^\]\r\n]+\]\]?[ \t]*$/gm;
const PYPROJECT_VERSION_RE = /^version = "([^"]+)"$/gm;
const PACKAGE_VERSION_RE = /^__version__ = "([^"]+)"$/gm;
const PYPROJECT_VERSION_ASSIGNMENT_RE = /^[ \t]*version[ \t]*=/gm;
const PACKAGE_VERSION_ASSIGNMENT_RE =
  /(?:^|;)[ \t]*__version__(?:[ \t]*:[^=;\n]+)?[ \t]*=/gm;
const PACKAGE_VERSION_IDENTIFIER_RE = /\b__version__\b/g;

function fail(message) {
  throw new Error(String(message));
}

export function normalizeStableMemOSVersion(raw) {
  const version = String(raw || "").trim();
  if (!version) fail("MemOS version is required.");
  if (version.startsWith("v"))
    fail("MemOS version must not include a leading v.");
  if (!STABLE_VERSION_RE.test(version)) {
    fail("MemOS version must be a stable X.Y.Z version without metadata.");
  }
  return version;
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

export function compareStableMemOSVersions(leftRaw, rightRaw) {
  const left = normalizeStableMemOSVersion(leftRaw).split(".");
  const right = normalizeStableMemOSVersion(rightRaw).split(".");
  for (let index = 0; index < left.length; index += 1) {
    const comparison = compareNumericIdentifier(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function expectedReleaseBranches(rawVersion) {
  const version = normalizeStableMemOSVersion(rawVersion);
  return {
    sourceBranch: `dev-v${version}`,
    releaseBranch: `release/v${version}`,
  };
}

function extractSingleVersion(text, pattern, assignmentPattern, path) {
  const assignments = [...String(text).matchAll(assignmentPattern)];
  if (assignments.length !== 1) {
    fail(
      `${path} must contain exactly one version assignment; found ${assignments.length}.`,
    );
  }
  const matches = [...String(text).matchAll(pattern)];
  if (matches.length !== 1) {
    fail(
      `${path} must contain exactly one canonical version declaration; found ${matches.length}.`,
    );
  }
  return normalizeStableMemOSVersion(matches[0][1]);
}

function projectSectionBounds(pyprojectText) {
  const text = String(pyprojectText);
  const sections = [...text.matchAll(PYPROJECT_SECTION_RE)];
  if (sections.length !== 1) {
    fail(
      `${MEMOS_PYPROJECT_PATH} must contain exactly one [project] section; found ${sections.length}.`,
    );
  }
  const start = sections[0].index + sections[0][0].length;
  TOML_SECTION_RE.lastIndex = start;
  const nextSection = TOML_SECTION_RE.exec(text);
  return { start, end: nextSection?.index ?? text.length };
}

function inspectPyprojectVersion(pyprojectText) {
  const bounds = projectSectionBounds(pyprojectText);
  return extractSingleVersion(
    String(pyprojectText).slice(bounds.start, bounds.end),
    PYPROJECT_VERSION_RE,
    PYPROJECT_VERSION_ASSIGNMENT_RE,
    `${MEMOS_PYPROJECT_PATH} [project]`,
  );
}

function inspectPackageVersion(packageInitText) {
  const identifiers = [
    ...String(packageInitText).matchAll(PACKAGE_VERSION_IDENTIFIER_RE),
  ];
  if (identifiers.length !== 1) {
    fail(
      `${MEMOS_PACKAGE_INIT_PATH} must contain exactly one __version__ identifier; found ${identifiers.length}.`,
    );
  }
  return extractSingleVersion(
    packageInitText,
    PACKAGE_VERSION_RE,
    PACKAGE_VERSION_ASSIGNMENT_RE,
    MEMOS_PACKAGE_INIT_PATH,
  );
}

function replacePyprojectVersion(pyprojectText, expectedVersion) {
  const text = String(pyprojectText);
  const bounds = projectSectionBounds(text);
  const section = text.slice(bounds.start, bounds.end);
  const nextSection = section.replace(
    /^version = "[^"]+"$/m,
    `version = "${expectedVersion}"`,
  );
  return `${text.slice(0, bounds.start)}${nextSection}${text.slice(bounds.end)}`;
}

export function inspectMemOSVersionTexts({ pyprojectText, packageInitText }) {
  const pyprojectVersion = inspectPyprojectVersion(pyprojectText);
  const packageVersion = inspectPackageVersion(packageInitText);
  if (pyprojectVersion !== packageVersion) {
    fail(
      `MemOS package versions do not match: ${MEMOS_PYPROJECT_PATH}=${pyprojectVersion}, ` +
        `${MEMOS_PACKAGE_INIT_PATH}=${packageVersion}.`,
    );
  }
  return { pyprojectVersion, packageVersion, version: pyprojectVersion };
}

export function assertMemOSVersionTexts({
  expectedVersion,
  pyprojectText,
  packageInitText,
}) {
  const expected = normalizeStableMemOSVersion(expectedVersion);
  const inspected = inspectMemOSVersionTexts({
    pyprojectText,
    packageInitText,
  });
  if (inspected.version !== expected) {
    fail(
      `MemOS package version mismatch: expected ${expected}, but both package files contain ` +
        `${inspected.version}. Run MemOS Release — Prepare and merge its PR before publishing.`,
    );
  }
  return inspected;
}

export function updateMemOSVersionTexts({
  expectedVersion,
  pyprojectText,
  packageInitText,
}) {
  const expected = normalizeStableMemOSVersion(expectedVersion);
  const inspected = inspectMemOSVersionTexts({
    pyprojectText,
    packageInitText,
  });
  const comparison = compareStableMemOSVersions(expected, inspected.version);
  if (comparison < 0) {
    fail(
      `Requested MemOS version ${expected} must be newer than the current version ${inspected.version}.`,
    );
  }
  if (comparison === 0) {
    return {
      ...inspected,
      previousVersion: inspected.version,
      changed: false,
      pyprojectText,
      packageInitText,
    };
  }

  const nextPyprojectText = replacePyprojectVersion(pyprojectText, expected);
  const nextPackageInitText = String(packageInitText).replace(
    /^__version__ = "[^"]+"$/m,
    `__version__ = "${expected}"`,
  );
  assertMemOSVersionTexts({
    expectedVersion: expected,
    pyprojectText: nextPyprojectText,
    packageInitText: nextPackageInitText,
  });

  return {
    pyprojectVersion: expected,
    packageVersion: expected,
    version: expected,
    previousVersion: inspected.version,
    changed: true,
    pyprojectText: nextPyprojectText,
    packageInitText: nextPackageInitText,
  };
}

export function updateMemOSVersionFiles({
  root = process.cwd(),
  expectedVersion,
}) {
  const pyprojectPath = resolve(root, MEMOS_PYPROJECT_PATH);
  const packageInitPath = resolve(root, MEMOS_PACKAGE_INIT_PATH);
  const result = updateMemOSVersionTexts({
    expectedVersion,
    pyprojectText: readFileSync(pyprojectPath, "utf8"),
    packageInitText: readFileSync(packageInitPath, "utf8"),
  });
  if (result.changed) {
    writeFileSync(pyprojectPath, result.pyprojectText, "utf8");
    writeFileSync(packageInitPath, result.packageInitText, "utf8");
  }
  return result;
}

function appendOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  writeFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`, {
    flag: "a",
  });
}

function readMemOSVersionFiles(root) {
  return {
    pyprojectText: readFileSync(resolve(root, MEMOS_PYPROJECT_PATH), "utf8"),
    packageInitText: readFileSync(
      resolve(root, MEMOS_PACKAGE_INIT_PATH),
      "utf8",
    ),
  };
}

function escapeWorkflowCommand(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

export function run(mode = process.argv[2] || "update") {
  const root = process.env.MEMOS_VERSION_ROOT || process.cwd();
  if (mode === "inspect") {
    const inspected = inspectMemOSVersionTexts(readMemOSVersionFiles(root));
    appendOutput("version", inspected.version);
    console.log(`MemOS package version is ${inspected.version}.`);
    return inspected;
  }

  const version = normalizeStableMemOSVersion(process.env.RELEASE_VERSION);
  const branches = expectedReleaseBranches(version);
  if (mode === "plan") {
    appendOutput("version", version);
    appendOutput("source_branch", branches.sourceBranch);
    appendOutput("release_branch", branches.releaseBranch);
    console.log(`Prepared release request for MemOS v${version}.`);
    return { version, ...branches };
  }
  if (mode === "require-newer") {
    const currentVersion = normalizeStableMemOSVersion(
      process.env.CURRENT_MEMOS_VERSION,
    );
    if (compareStableMemOSVersions(version, currentVersion) <= 0) {
      fail(
        `Requested MemOS version ${version} must be newer than main package version ${currentVersion}.`,
      );
    }
    console.log(
      `Requested MemOS version ${version} is newer than main package version ${currentVersion}.`,
    );
    return { version, currentVersion, ...branches };
  }
  if (mode === "assert") {
    const inspected = assertMemOSVersionTexts({
      expectedVersion: version,
      ...readMemOSVersionFiles(root),
    });
    console.log(`MemOS package version matches ${version}.`);
    return inspected;
  }
  if (mode !== "update") fail(`Unsupported memos-version mode: ${mode}`);

  const result = updateMemOSVersionFiles({ root, expectedVersion: version });
  appendOutput("version", version);
  appendOutput("source_branch", branches.sourceBranch);
  appendOutput("release_branch", branches.releaseBranch);
  appendOutput("previous_version", result.previousVersion);
  appendOutput("changed", result.changed);
  console.log(
    result.changed
      ? `Updated MemOS package version ${result.previousVersion} -> ${version}.`
      : `MemOS package version is already ${version}.`,
  );
  return result;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    run();
  } catch (error) {
    console.error(`::error::${escapeWorkflowCommand(error?.message || error)}`);
    process.exit(1);
  }
}
