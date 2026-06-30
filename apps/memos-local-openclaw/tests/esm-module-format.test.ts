/**
 * Regression tests for issue #1733:
 *   "@memtensor/memos-lite-openclaw-plugin v0.2.3 fails to load:
 *    ReferenceError: exports is not defined in ES module scope"
 *
 * Root cause in v0.2.3:
 *   - package.json declared `"type": "module"` (so Node treats every `.js`
 *     file in the package as an ES module).
 *   - The published tarball still shipped `dist/*.js` files compiled with
 *     `"module": "CommonJS"`, which contain `Object.defineProperty(exports, ...)`
 *     and `require(...)`. Node 22+ then refused to load them.
 *
 * Permanent fix — source-only publish + ESM-flavoured tsconfig:
 *   1. `package.json.files` may not ship `dist/`, `dist/**`, or any
 *      bare `.js`/`.mjs` file. Anything JS-shaped that ships must use
 *      the explicit `.cjs` extension so Node interprets it as CommonJS
 *      regardless of the `type: "module"` setting.
 *   2. `package.json.main` (and `openclaw.extensions`) must point at a
 *      `.ts` source file (loaded by OpenClaw via tsx) or a `.cjs` file —
 *      never a bare `.js` file, which would resolve as ESM and crash on
 *      CommonJS-flavoured output.
 *   3. `tsconfig.json` must not emit CommonJS-flavoured `.js` (`module`
 *      must be one of the ESM variants), and `moduleResolution` must be
 *      compatible with ESM emit without rewriting every relative import
 *      to add an explicit `.js` extension.
 *   4. If a `dist/index.js` ever appears in the workspace (e.g. a stale
 *      local build), it must not contain CommonJS export markers.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const pluginRoot = resolve(dirname(__filename), "..");

function readJsonStripComments(filePath: string): Record<string, any> {
  // tsconfig allows // and /* */ comments and trailing commas; strip them
  // before JSON.parse so this test stays dependency-free.
  let text = readFileSync(filePath, "utf-8");
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  text = text.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  text = text.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text);
}

function readPackageJson(): Record<string, any> {
  return readJsonStripComments(resolve(pluginRoot, "package.json"));
}

function readTsconfig(): Record<string, any> {
  return readJsonStripComments(resolve(pluginRoot, "tsconfig.json"));
}

describe("issue #1733 — ESM module format does not regress", () => {
  it("package.json declares type: module (matches Node 22+ ESM-by-default expectation)", () => {
    const pkg = readPackageJson();
    expect(
      pkg.type,
      "If `type` is missing or 'commonjs', remove the ESM-specific source features (`import.meta.url`, `createRequire(import.meta.url)`) from index.ts first.",
    ).toBe("module");
  });

  it("package.json.files does not ship a `dist` directory (would re-introduce v0.2.3 CJS/ESM conflict)", () => {
    const pkg = readPackageJson();
    const files: unknown[] = Array.isArray(pkg.files) ? pkg.files : [];
    const offenders = files.filter((entry) => {
      if (typeof entry !== "string") return false;
      const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "");
      return (
        normalized === "dist" ||
        normalized === "dist/" ||
        normalized.startsWith("dist/") ||
        normalized.startsWith("dist\\")
      );
    });
    expect(
      offenders,
      `Shipping dist/* in an ESM package re-introduces issue #1733: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("package.json.files only ships .ts source or explicit .cjs scripts (never bare .js / .mjs)", () => {
    const pkg = readPackageJson();
    const files: unknown[] = Array.isArray(pkg.files) ? pkg.files : [];
    const offenders = files.filter((entry) => {
      if (typeof entry !== "string") return false;
      const ext = extname(entry).toLowerCase();
      return ext === ".js" || ext === ".mjs";
    });
    expect(
      offenders,
      `A bare .js file in an ESM package gets loaded as ESM. ` +
        `If it contains CommonJS (exports/require) Node will throw the v0.2.3 error. ` +
        `Rename to .cjs (or .ts if loaded via tsx). Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("package.json.main points at a TypeScript source file (loaded by OpenClaw/tsx) or an explicit .cjs script", () => {
    const pkg = readPackageJson();
    const main = pkg.main;
    expect(typeof main).toBe("string");
    const ext = extname(main as string).toLowerCase();
    expect(
      [".ts", ".cjs"].includes(ext),
      `package.json.main="${main}" must use .ts or .cjs. ` +
        `A .js entry under "type": "module" is exactly what broke v0.2.3.`,
    ).toBe(true);
  });

  it("openclaw extensions only reference .ts entries (so OpenClaw loads via tsx, not Node's ESM loader)", () => {
    const pkg = readPackageJson();
    const extensions = pkg.openclaw?.extensions;
    expect(Array.isArray(extensions)).toBe(true);
    for (const entry of extensions as unknown[]) {
      expect(typeof entry).toBe("string");
      const ext = extname(entry as string).toLowerCase();
      expect(
        [".ts", ".cjs"].includes(ext),
        `openclaw.extensions entry "${entry}" must be .ts or .cjs to avoid Node's strict .js→ESM resolution.`,
      ).toBe(true);
    }
  });

  it("tsconfig.json emits ESM, not CommonJS (would re-create the v0.2.3 conflict on local builds)", () => {
    const tsc = readTsconfig();
    const moduleSetting = String(tsc.compilerOptions?.module ?? "").toLowerCase();

    // Forbidden: any CommonJS-flavoured emit — produces `exports.X = ...`
    // which collides with `"type": "module"` in Node 22+ ESM mode.
    expect(moduleSetting).not.toBe("commonjs");
    expect(moduleSetting).not.toBe("none");

    // Required: an ESM-emitting module mode.
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
    expect(
      esmModes.has(moduleSetting),
      `tsconfig "module": "${moduleSetting}" is not ESM-flavoured. ` +
        `Building would emit dist/*.js with module.exports/require(), which clashes with package.json "type": "module".`,
    ).toBe(true);
  });

  it("tsconfig.json sets a module resolution compatible with ESM emit", () => {
    const tsc = readTsconfig();
    const resolution = String(
      tsc.compilerOptions?.moduleResolution ?? "",
    ).toLowerCase();

    // Required for ESM emit to work without rewriting every relative import
    // path to include explicit ".js" extensions throughout src/.
    const allowed = new Set(["bundler", "node16", "node18", "nodenext"]);
    expect(
      allowed.has(resolution),
      `tsconfig "moduleResolution": "${resolution}" is incompatible with ESM emit ` +
        `(or requires explicit .js extensions in every import). ` +
        `Use one of: ${[...allowed].join(", ")}.`,
    ).toBe(true);
  });

  it("compiled output (if any) does not contain CommonJS export markers", () => {
    // The plugin is source-only published — there is normally no dist/ at all.
    // But if a developer happened to run `npm run build` locally, sanity-check
    // that the output is not CJS-shaped. We do not force a build here.
    const distEntry = join(pluginRoot, "dist", "index.js");
    if (!existsSync(distEntry)) {
      // Source-only publish is the happy path; nothing to check.
      return;
    }
    const text = readFileSync(distEntry, "utf-8");
    expect(text).not.toMatch(/Object\.defineProperty\(exports,/);
    expect(text).not.toMatch(/^exports\./m);
  });
});
