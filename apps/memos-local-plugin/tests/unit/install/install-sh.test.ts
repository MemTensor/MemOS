/**
 * install.sh smoke tests.
 *
 * The new install.sh is minimal: only `--version`, plus an
 * interactive picker (ENTER = auto-detect). It patches real host files
 * (~/.openclaw/openclaw.json etc.) and stops / starts the agent gateway,
 * so we deliberately keep unit tests narrow — they only exercise what
 * can be checked without side effects on the developer's machine:
 *
 *   1. `--help` exits 0 and prints the usage banner.
 *   2. An unknown flag exits non-zero.
 *   3. Removed legacy flags report an error cleanly.
 *
 * End-to-end behaviour is verified manually (the script is driven
 * against real ~/.openclaw / ~/.hermes hosts during release testing).
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "install.sh");
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("install.sh — CLI surface", () => {
  it("prints usage on --help and exits 0", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("--version");
    expect(r.stdout).not.toContain("bash install.sh --port");
  });

  it("prints usage on -h and exits 0", () => {
    const r = run(["-h"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  it("rejects unknown arguments with non-zero exit", () => {
    const r = run(["blobfish"]);
    expect(r.code).not.toBe(0);
    const combined = `${r.stdout}\n${r.stderr}`.toLowerCase();
    expect(combined).toContain("unknown argument");
  });

  it("rejects --uninstall (removed from this version)", () => {
    // Older scripts supported `--uninstall`; the new minimal CLI drops
    // it to keep the surface to just `--version` + `--port`. This test
    // guards against us accidentally re-adding the flag without updating
    // the docs/tests alongside it.
    const r = run(["--uninstall", "openclaw"]);
    expect(r.code).not.toBe(0);
  });

  it("rejects --port (fixed per-agent ports are used)", () => {
    const r = run(["--port", "18799"]);
    expect(r.code).not.toBe(0);
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).toContain("--port is no longer supported");
  });

  it("generates an OpenClaw manifest that points at compiled runtime output", () => {
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toContain('OPENCLAW_RUNTIME_ENTRY="./dist/adapters/openclaw/index.js"');
    expect(script).toContain('"extensions": ["${OPENCLAW_RUNTIME_ENTRY}"]');
    expect(script).toContain('"contracts": {');
    expect(script).toContain('"memory_search"');
    expect(script).toContain("if (config.plugins.entries[pluginId].hooks) delete config.plugins.entries[pluginId].hooks");
    expect(script).not.toContain('"extensions": ["./adapters/openclaw/index.ts"]');
  });

  it("publishes package runtime output and viewer sources without docs, tests, or site", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      files?: string[];
      main?: string;
      openclaw?: { extensions?: string[] };
      scripts?: { build?: string };
    };
    expect(pkg.main).toBe("dist/core/index.js");
    expect(pkg.scripts?.build).toContain("scripts/copy-runtime-assets.cjs");
    expect(pkg.openclaw?.extensions).toContain("./dist/adapters/openclaw/index.js");
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("web");
    expect(pkg.files).not.toContain("web/dist");
    expect(pkg.files).not.toContain("docs");
    expect(pkg.files).not.toContain("tests");
    expect(pkg.files).not.toContain("site");
    expect(pkg.files).not.toContain("site/dist");
  });
});
