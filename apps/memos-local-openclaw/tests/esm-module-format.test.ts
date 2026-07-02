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
 * Permanent fix — ESM-flavoured tsconfig + ESM dist publish:
 *   1. `package.json.files` must ship the built `dist/` output that
 *      `prepack` produces, plus explicit `.cjs` scripts for CommonJS helpers.
 *   2. `package.json.main` and `openclaw.extensions` point at `dist/index.js`;
 *      because package.json has `type: "module"`, that file must be true ESM
 *      output, never CommonJS-flavoured output.
 *   3. `tsconfig.json` must not emit CommonJS-flavoured `.js` (`module`
 *      must be one of the ESM variants), and `moduleResolution` must be
 *      compatible with ESM emit without rewriting every relative import
 *      to add an explicit `.js` extension.
 *   4. `dist/index.js` must not contain CommonJS export markers.
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

  it("package.json.files ships the built dist directory", () => {
    const pkg = readPackageJson();
    const files: unknown[] = Array.isArray(pkg.files) ? pkg.files : [];
    expect(files).toContain("dist");
  });

  it("package.json.files only ships dist output or explicit .cjs scripts", () => {
    const pkg = readPackageJson();
    const files: unknown[] = Array.isArray(pkg.files) ? pkg.files : [];
    const offenders = files.filter((entry) => {
      if (typeof entry !== "string") return false;
      const ext = extname(entry).toLowerCase();
      if (ext !== ".js" && ext !== ".mjs") return false;
      const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "");
      return !normalized.startsWith("dist/");
    });
    expect(
      offenders,
      `Only built dist ESM files may ship as bare .js/.mjs. ` +
        `CommonJS helpers must use .cjs. Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("package.json.main points at the built ESM entry", () => {
    const pkg = readPackageJson();
    const main = pkg.main;
    expect(typeof main).toBe("string");
    expect(main).toBe("dist/index.js");
  });

  it("openclaw extensions reference the built ESM entry", () => {
    const pkg = readPackageJson();
    const extensions = pkg.openclaw?.extensions;
    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions).toEqual(["./dist/index.js"]);
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
    // npm prepack runs `npm run build`, so the published package includes dist.
    // If a developer has not built locally yet, skip this source-tree-only check.
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
