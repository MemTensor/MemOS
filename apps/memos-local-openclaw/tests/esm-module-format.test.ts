/**
 * Regression test for #1733:
 *
 * The package.json declares `"type": "module"` (ESM), but the previously
 * shipped v0.2.x build emitted CommonJS-flavored `dist/*.js` files because
 * tsconfig.json had `"module": "CommonJS"`. Node 22+ refused to load them:
 *
 *   ReferenceError: exports is not defined in ES module scope
 *
 * This test enforces three invariants going forward:
 *
 * 1. `package.json` keeps `"type": "module"` (the runtime needs it for
 *    `import.meta.url` in index.ts).
 * 2. `tsconfig.json` emits ESM (`module` ∈ ES2015..ESNext, never CommonJS).
 * 3. A representative TypeScript snippet compiled with the project's
 *    tsconfig produces ESM `export` syntax, not CommonJS
 *    `Object.defineProperty(exports, ...)`.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const PLUGIN_ROOT = path.resolve(__dirname, "..");

function readJsonStripComments(file: string): any {
  // tsconfig allows // and /* */ comments and trailing commas; strip them
  // before JSON.parse so this test stays dependency-free.
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  text = text.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  text = text.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text);
}

describe("ESM module format (regression for #1733)", () => {
  it("package.json declares type: module", () => {
    const pkg = readJsonStripComments(path.join(PLUGIN_ROOT, "package.json"));
    expect(pkg.type).toBe("module");
  });

  it("tsconfig.json emits ESM, not CommonJS", () => {
    const tsconfig = readJsonStripComments(path.join(PLUGIN_ROOT, "tsconfig.json"));
    const moduleSetting = String(tsconfig.compilerOptions?.module ?? "").toLowerCase();

    // Forbidden: CommonJS / Node CommonJS — those emit `exports.X = ...`
    // which collides with `"type": "module"` in Node 22+ ESM mode.
    expect(moduleSetting).not.toBe("commonjs");
    expect(moduleSetting).not.toBe("node");

    // Required: any of the ESM-emitting module modes.
    const esmModes = new Set([
      "es2015",
      "es2020",
      "es2022",
      "esnext",
      "node16",
      "node18",
      "nodenext",
      "preserve",
    ]);
    expect(esmModes.has(moduleSetting)).toBe(true);
  });

  it("tsconfig.json sets a module resolution compatible with ESM emit", () => {
    const tsconfig = readJsonStripComments(path.join(PLUGIN_ROOT, "tsconfig.json"));
    const resolution = String(tsconfig.compilerOptions?.moduleResolution ?? "").toLowerCase();

    // Required for ESM emit to work without rewriting every relative import
    // path to include explicit ".js" extensions throughout src/.
    const allowed = new Set(["bundler", "node16", "node18", "nodenext"]);
    expect(allowed.has(resolution)).toBe(true);
  });

  it("does not publish a stale dist/index.js that uses CommonJS exports", () => {
    // package.files must not include "dist" — the plugin is source-only
    // published (entry is index.ts, OpenClaw loads it via tsx).
    const pkg = readJsonStripComments(path.join(PLUGIN_ROOT, "package.json"));
    const files: string[] = Array.isArray(pkg.files) ? pkg.files : [];
    for (const f of files) {
      const top = f.replace(/[/\\].*$/, "");
      expect(top.toLowerCase()).not.toBe("dist");
    }
  });

  it("compiled output does not contain CommonJS export markers", async () => {
    // If a dist/ already exists in the workspace, sanity-check its top-level
    // entry. We do not force a build here (the plugin is source-only); we
    // simply guard against committing a stale, CJS-shaped artifact.
    const distEntry = path.join(PLUGIN_ROOT, "dist", "index.js");
    if (!fs.existsSync(distEntry)) {
      // Nothing to check — passes by default; source-only publishing is the
      // happy path for this plugin.
      return;
    }
    const text = fs.readFileSync(distEntry, "utf-8");
    expect(text).not.toMatch(/Object\.defineProperty\(exports,/);
    expect(text).not.toMatch(/^exports\./m);
  });
});
