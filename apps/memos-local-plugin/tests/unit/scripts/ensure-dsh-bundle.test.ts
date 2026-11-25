import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureDshBundle } from "../../../scripts/ensure-dsh-bundle.mjs";

const name = "@memtensor/memos-local-plugin";
const script = resolve(import.meta.dirname, "../../../scripts/ensure-dsh-bundle.mjs");

function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), "memos-bundle-registration-"));
  const file = resolve(dir, "package.json");
  const pluginDir = resolve(dir, "node_modules", name);
  mkdirSync(resolve(pluginDir, "adapters/deepseek-harness"), { recursive: true });
  mkdirSync(resolve(pluginDir, "dist/adapters/deepseek-harness"), { recursive: true });
  writeFileSync(resolve(pluginDir, "package.json"), JSON.stringify({ name, version: "2.0.21-beta.1", dsh: { bundle: { patch: "./adapters/deepseek-harness/cordis.patch.yml" } } }));
  writeFileSync(resolve(pluginDir, "adapters/deepseek-harness/cordis.patch.yml"), "[]\n");
  writeFileSync(resolve(pluginDir, "dist/adapters/deepseek-harness/index.js"), "export {};\n");
  const manifest = {
    name: "synthetic-profile",
    dependencies: { [name]: "file:synthetic.tgz", "other-disabled-plugin": "1.0.0" },
    scripts: { unrelated: "synthetic" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "other-enabled-plugin"], unrelated: true }, unrelated: true },
  };
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return { dir, file, pluginDir, manifest, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("explicit DSH bundle registration", () => {
  it("runs its CLI through a pnpm-style node_modules directory link", () => {
    const f = fixture();
    try {
      symlinkSync(dirname(script), resolve(f.pluginDir, "scripts"), "junction");
      const result = spawnSync(process.execPath, [resolve(f.pluginDir, "scripts/ensure-dsh-bundle.mjs")], { cwd: f.dir, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('"changed":true');
      expect(JSON.parse(readFileSync(f.file, "utf8")).dsh.profile.bundles).toContain(name);
    } finally { f.cleanup(); }
  });

  it("repairs only the requested package while preserving bundle order and unrelated fields", () => {
    const f = fixture();
    try {
      expect(ensureDshBundle(f.dir)).toMatchObject({ changed: true, package: name });
      expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual({
        ...f.manifest,
        dsh: { ...f.manifest.dsh, profile: { ...f.manifest.dsh.profile, bundles: [...f.manifest.dsh.profile.bundles, name] } },
      });
      const once = readFileSync(f.file, "utf8");
      expect(ensureDshBundle(f.dir).changed).toBe(false);
      expect(readFileSync(f.file, "utf8")).toBe(once);
    } finally { f.cleanup(); }
  });

  it("creates missing profile metadata and accepts CRLF input", () => {
    const f = fixture();
    try {
      writeFileSync(f.file, JSON.stringify({ dependencies: f.manifest.dependencies }, null, 2).replace(/\n/g, "\r\n") + "\r\n");
      ensureDshBundle(f.dir);
      const text = readFileSync(f.file, "utf8");
      expect(JSON.parse(text).dsh.profile.bundles).toEqual([name]);
      expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    } finally { f.cleanup(); }
  });

  it.each(["package.json", "adapters/deepseek-harness/cordis.patch.yml", "dist/adapters/deepseek-harness/index.js"])("refuses an incomplete install missing %s without changing the profile", (missing) => {
    const f = fixture();
    try {
      const before = readFileSync(f.file, "utf8");
      unlinkSync(resolve(f.pluginDir, missing));
      expect(() => ensureDshBundle(f.dir)).toThrow();
      expect(readFileSync(f.file, "utf8")).toBe(before);
    } finally { f.cleanup(); }
  });

  it.each([
    { dependencies: {} },
    { dsh: [] },
    { dsh: { profile: { bundles: "invalid" } } },
    { dsh: { profile: { bundles: [17] } } },
  ])("refuses malformed or missing profile declarations without changing them: %j", (patch) => {
    const f = fixture();
    try {
      const before = JSON.stringify({ ...f.manifest, ...patch });
      writeFileSync(f.file, before);
      expect(() => ensureDshBundle(f.dir)).toThrow();
      expect(readFileSync(f.file, "utf8")).toBe(before);
    } finally { f.cleanup(); }
  });

  it("uses only the selected profile directory and ships in the tarball file list", () => {
    const selected = fixture(), other = fixture();
    try {
      const before = readFileSync(other.file, "utf8");
      const result = spawnSync(process.execPath, [script], { cwd: selected.dir, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).changed).toBe(true);
      expect(readFileSync(other.file, "utf8")).toBe(before);
      const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8"));
      expect(pkg.files).toContain("scripts/ensure-dsh-bundle.mjs");
    } finally { selected.cleanup(); other.cleanup(); }
  });
});
