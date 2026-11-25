import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../..");
const selector = "tsx@4.21.0>esbuild";
const readJson = (file: string) => JSON.parse(readFileSync(resolve(root, file), "utf8"));

describe("reviewed tsx/esbuild installation", () => {
  it("pins the runtime and its build dependency in both source package managers", () => {
    const pkg = readJson("package.json");
    const npm = readJson("package-lock.json");
    const workspace = parse(readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8"));
    const pnpm = parse(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"));

    expect(pkg.dependencies.tsx).toBe("4.21.0");
    expect(npm.packages[""].dependencies.tsx).toBe("4.21.0");
    expect(pkg.overrides["tsx@4.21.0"].esbuild).toBe("0.27.7");
    expect(workspace.overrides[selector]).toBe("0.27.7");
    expect(pnpm.overrides[selector]).toBe("0.27.7");
    expect(pnpm.importers["."].dependencies.tsx.specifier).toBe("4.21.0");
    expect(pkg.allowScripts["esbuild@0.27.7"]).toBe(true);
    expect(workspace.allowBuilds["esbuild@0.27.7"]).toBe(true);
    expect(pkg.allowScripts.esbuild).toBeUndefined();
    expect(workspace.allowBuilds.esbuild).toBeUndefined();
  });

  function withProfile(input: string, test: (file: string, run: () => ReturnType<typeof spawnSync>) => void): void {
    const dir = mkdtempSync(resolve(tmpdir(), "memos-tsx-policy-"));
    const file = resolve(dir, "pnpm-workspace.yaml");
    const source = readFileSync(resolve(root, "install.sh"), "utf8");
    const fn = source.slice(source.indexOf("prepare_dsh_build_policy() {"), source.indexOf("\nrun_dsh_plugin_without_onnx_cuda()"));
    writeFileSync(file, input);
    try {
      test(file, () => spawnSync("bash", ["-c", `${fn}\nprepare_dsh_build_policy "$1"`, "bash", file], { encoding: "utf8" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each(["\n", "\r\n"])("pins the consumer profile before installation, preserving settings and %j line endings", (eol) => {
    withProfile(["packages:", "  - .", "overrides:", "  unrelated: 1.2.3", "allowBuilds:", "  other: false", ""].join(eol), (file, run) => {
      expect(run().status).toBe(0);
      const once = readFileSync(file, "utf8");
      expect(parse(once).overrides).toEqual({ unrelated: "1.2.3", [selector]: "0.27.7" });
      expect(parse(once).allowBuilds.other).toBe(false);
      if (eol === "\r\n") expect(once.replace(/\r\n/g, "")).not.toContain("\n");
      expect(run().status).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(once);
    });
  });

  it("adds the consumer override to an empty profile", () => {
    withProfile("", (file, run) => {
      expect(run().status).toBe(0);
      expect(parse(readFileSync(file, "utf8")).overrides[selector]).toBe("0.27.7");
    });
  });

  it.each([
    "overrides:\n  'tsx@4.21.0>esbuild': 0.28.2\n",
    "overrides:\n  esbuild: 0.28.2\n",
    "overrides: {esbuild: 0.28.2}\n",
  ])("refuses a conflicting consumer override without rewriting the profile: %s", (input) => {
    withProfile(input, (file, run) => {
      expect(run().status).not.toBe(0);
      expect(readFileSync(file, "utf8")).toBe(input);
    });
  });
});
