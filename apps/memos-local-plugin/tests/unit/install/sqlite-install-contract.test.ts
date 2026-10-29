import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bootstrapMemoryCoreFull } from "../../../core/pipeline/memory-core.js";
const root = path.resolve(__dirname, "../../..");
const normalizer = path.join(root, "scripts/normalize-sqlite-lock.cjs");
describe("SQLite prebuilt installation contract", () => {
  it("rejects an old actual host runtime before opening storage", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    Object.defineProperty(process.versions, "node", { value: "20.19.0", configurable: true });
    try {
      await expect(bootstrapMemoryCoreFull({ agent: "deepseek-harness", get home(): never { throw new Error("storage must not be resolved"); } })).rejects.toThrow(/Node.js >=22/);
    } finally { Object.defineProperty(process.versions, "node", descriptor); }
  });
  it("keeps runtime declarations, both lockfiles and build policy consistent", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
    expect(pkg.engines.node).toBe(">=22.0.0");
    expect(pkg.dependencies["better-sqlite3"]).toBe("13.0.3");
    expect(lock.packages[""].dependencies["better-sqlite3"]).toBe("13.0.3");
    expect(lock.packages["node_modules/better-sqlite3"]).toMatchObject({version: "13.0.3", gypfile: false, hasInstallScript: false});
    expect(pkg.allowScripts["better-sqlite3"]).toBe(false);
    expect(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8")).toMatch(/better-sqlite3:\s+specifier: 13\.0\.3\s+version: 13\.0\.3/);
  });
  it("normalizes only reviewed SQLite metadata and detects later drift", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sqlite-lock-test-"));
    const file = path.join(dir, "package-lock.json");
    const actual = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
    delete actual.packages["node_modules/better-sqlite3"].gypfile;
    delete actual.packages["node_modules/better-sqlite3"].hasInstallScript;
    writeFileSync(file, JSON.stringify(actual));
    const run = (...args: string[]) => spawnSync(process.execPath, [normalizer, file, ...args], { encoding: "utf8" });
    try {
      expect(run("--check").status).not.toBe(0);
      expect(run().status).toBe(0);
      expect(run("--check").status).toBe(0);
      const repaired = JSON.parse(readFileSync(file, "utf8"));
      expect(repaired.packages["node_modules/better-sqlite3"]).toMatchObject({gypfile: false, hasInstallScript: false});
      repaired.packages["node_modules/better-sqlite3"].integrity = "unreviewed";
      writeFileSync(file, JSON.stringify(repaired));
      expect(run().status).not.toBe(0);
      expect(JSON.parse(readFileSync(file, "utf8")).packages["node_modules/better-sqlite3"].integrity).toBe("unreviewed");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("preseeds DSH policy, preserves unrelated settings and refuses an explicit denial", () => {
    const source = readFileSync(path.join(root, "install.sh"), "utf8");
    const fn = source.slice(source.indexOf("prepare_dsh_build_policy() {"), source.indexOf("\nrun_dsh_plugin_without_onnx_cuda()"));
    const dir = mkdtempSync(path.join(tmpdir(), "dsh-policy-test-"));
    const file = path.join(dir, "pnpm-workspace.yaml");
    const run = () => spawnSync("bash", ["-c", `${fn}\nprepare_dsh_build_policy "$1"`, "bash", file], { encoding: "utf8" });
    try {
      writeFileSync(file, "packages:\n  - .\nallowBuilds:\n  other: false\n");
      expect(run().status).toBe(0);
      const once = readFileSync(file, "utf8");
      expect(once).toContain('"better-sqlite3": false');
      expect(once).toContain("other: false");
      expect(run().status).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(once);
      writeFileSync(file, "allowBuilds:\n  esbuild: false\n");
      expect(run().status).not.toBe(0);
      expect(readFileSync(file, "utf8")).toBe("allowBuilds:\n  esbuild: false\n");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses Node 20 before attempting a deployment", () => {
    const source = readFileSync(path.join(root, "install.sh"), "utf8");
    const fn = source.slice(source.indexOf("ensure_node() {"), source.indexOf("\n}", source.indexOf("ensure_node() {")) + 2);
    const run = spawnSync("bash", ["-c", `REQUIRED_NODE_MAJOR=22; node_major() { echo 20; }; die() { echo "$*"; exit 1; }; ${fn}\nensure_node`], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain("existing plugin has not been replaced");
  });

  it.skipIf(process.platform === "win32")("leaves an existing deployment untouched when dependency staging fails", () => {
    const source = readFileSync(path.join(root, "install.sh"), "utf8");
    const start = source.indexOf("deploy_tarball_to_prefix() {");
    const fn = source.slice(start, source.indexOf("\n# ─── Generate runtime", start));
    const dir = mkdtempSync(path.join(tmpdir(), "sqlite-stage-test-"));
    const prefix = path.join(dir, "existing");
    const unpacked = path.join(dir, "package");
    // Use a real tarball but a failing npm boundary; no user host is involved.
    spawnSync("mkdir", ["-p", prefix, unpacked]);
    writeFileSync(path.join(prefix, "package.json"), "old-install");
    writeFileSync(path.join(unpacked, "package.json"), "{}");
    const tarball = path.join(dir, "candidate.tgz");
    expect(spawnSync("tar", ["czf", tarball, "-C", dir, "package"]).status).toBe(0);
    try {
      const result = spawnSync("bash", ["-c", `step() { :; }; success() { :; }; warn() { :; }; die() { echo "$*"; exit 1; }; npm() { return 66; }; BUILT_TARBALL="$2"; ${fn}\ndeploy_tarball_to_prefix "$1"`, "bash", prefix, tarball], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("existing installation is unchanged");
      expect(readFileSync(path.join(prefix, "package.json"), "utf8")).toBe("old-install");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
