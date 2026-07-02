/**
 * Regression test for issue #1733
 * (@memtensor/memos-lite-openclaw-plugin v0.2.3 fails to load:
 *  "ReferenceError: exports is not defined in ES module scope").
 *
 * Root cause: package.json declared `"type": "module"` while tsconfig.json
 * emitted CommonJS (`"module": "CommonJS"`). Node.js treated the compiled
 * `dist/index.js` as ESM, saw the `exports.` writes, and refused to load
 * the plugin.
 *
 * Guard the invariant so it cannot silently drift again:
 *  - When package.json says "type": "module", tsconfig must emit an ESM
 *    module format (not CommonJS / node16 / commonjs variants).
 *  - When ESM is chosen, `moduleResolution` must be one of the ESM-safe
 *    variants ("bundler" / "nodenext" / "node16"). Bare `"node"` (which is
 *    equivalent to the legacy classic CJS resolver) would silently mask
 *    ESM-only imports at build time.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Strip // and /* */ comments and trailing commas so JSON.parse can eat tsconfig.
function readJsoncSync(path: string): any {
  const raw = readFileSync(path, "utf-8");
  const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock.replace(/(^|[^:])\/\/.*$/gm, "$1");
  const noTrailingCommas = noLine.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noTrailingCommas);
}

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgJsonPath = resolve(pluginRoot, "package.json");
const tsconfigPath = resolve(pluginRoot, "tsconfig.json");

const CJS_MODULES = new Set(["commonjs", "node16-commonjs"]);
const ESM_MODULES = new Set([
  "es2015",
  "es2020",
  "es2022",
  "esnext",
  "node16",
  "node18",
  "nodenext",
]);
const ESM_SAFE_RESOLUTIONS = new Set([
  "bundler",
  "node16",
  "node18",
  "nodenext",
]);

describe("regression #1733 — plugin module-format alignment", () => {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  const tsconfig = readJsoncSync(tsconfigPath);
  const module = String(tsconfig.compilerOptions?.module ?? "").toLowerCase();
  const moduleResolution = String(
    tsconfig.compilerOptions?.moduleResolution ?? "",
  ).toLowerCase();

  it("package.json declares ESM", () => {
    // If this ever flips back to CommonJS or is removed, the tsconfig side
    // of the invariant needs to be revisited in tandem.
    expect(pkg.type).toBe("module");
  });

  it("tsconfig emits an ESM-compatible module format", () => {
    expect(ESM_MODULES.has(module), `tsconfig module=${module} is CJS-flavoured; would recreate the v0.2.3 "exports is not defined" crash when dist/index.js is loaded under package.json "type": "module".`).toBe(true);
    expect(CJS_MODULES.has(module)).toBe(false);
  });

  it("tsconfig moduleResolution is ESM-safe", () => {
    expect(
      ESM_SAFE_RESOLUTIONS.has(moduleResolution),
      `moduleResolution="${moduleResolution}" pairs the ESM emit with the legacy CJS resolver — imports get silently rewritten in ways Node can't execute at runtime.`,
    ).toBe(true);
  });

  it("no legacy CommonJS entry point sneaks back in", () => {
    // main + openclaw.extensions must not reference a CJS-only artifact.
    const main: string = pkg.main ?? "";
    expect(main.endsWith(".cjs")).toBe(false);

    const ext = pkg.openclaw?.extensions;
    if (Array.isArray(ext)) {
      for (const e of ext) {
        expect(
          String(e).endsWith(".cjs"),
          `openclaw.extensions entry "${e}" would force CommonJS load under type:module.`,
        ).toBe(false);
      }
    }
  });
});
