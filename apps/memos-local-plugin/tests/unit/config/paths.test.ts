import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as pathResolve, join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveHome,
  expandHome,
  selectWindowsHermesRuntimeHome,
} from "../../../core/config/paths.js";

const SAVED = { ...process.env };
function restoreEnv() {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  for (const [k, v] of Object.entries(SAVED)) process.env[k] = v;
}

describe("config/paths", () => {
  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  it("resolves the OpenClaw default home under the user's home dir", () => {
    delete process.env["MEMOS_HOME"];
    delete process.env["MEMOS_CONFIG_FILE"];
    const home = resolveHome("openclaw");
    expect(home.root).toBe(pathResolve(join(homedir(), ".openclaw/memos-plugin")));
    expect(home.configFile).toBe(join(home.root, "config.yaml"));
    expect(home.dbFile).toBe(join(home.root, "data", "memos.db"));
    expect(home.logsDir).toBe(join(home.root, "logs"));
  });

  it("MEMOS_HOME wins over the per-agent default", () => {
    process.env["MEMOS_HOME"] = "/tmp/forced/memos";
    const home = resolveHome("hermes");
    expect(home.root).toBe("/tmp/forced/memos");
    expect(home.configFile).toBe("/tmp/forced/memos/config.yaml");
  });

  it("MEMOS_CONFIG_FILE without MEMOS_HOME derives root from the file's parent", () => {
    delete process.env["MEMOS_HOME"];
    process.env["MEMOS_CONFIG_FILE"] = "/var/etc/some.yaml";
    const home = resolveHome("openclaw");
    expect(home.configFile).toBe("/var/etc/some.yaml");
    expect(home.root).toBe("/var/etc");
  });

  it("expandHome resolves leading ~ and {HOME} placeholder", () => {
    expect(expandHome("~/foo/bar")).toBe(join(homedir(), "foo/bar"));
    expect(expandHome("{HOME}/.x/y")).toBe(join(homedir(), ".x/y"));
    expect(expandHome("/abs/already")).toBe("/abs/already");
  });

  it("falls back gracefully for unknown agent kinds", () => {
    delete process.env["MEMOS_HOME"];
    delete process.env["MEMOS_CONFIG_FILE"];
    const home = resolveHome("custom");
    expect(home.root.endsWith(".custom/memos-plugin")).toBe(true);
  });

  it("keeps a legacy Windows Hermes database in place and persists the choice", () => {
    const root = mkdtempSync(join(tmpdir(), "memos-win-home-"));
    const legacyHome = join(root, "legacy", "memos-plugin");
    const installRoot = join(root, "local", "hermes", "memos-plugin");
    mkdirSync(join(legacyHome, "data"), { recursive: true });
    writeFileSync(join(legacyHome, "data", "memos.db"), "legacy");

    const selected = selectWindowsHermesRuntimeHome({ legacyHome, installRoot });

    expect(selected).toMatchObject({ root: legacyHome, source: "legacy-database" });
    expect(JSON.parse(readFileSync(join(installRoot, ".memos-runtime-home"), "utf8")))
      .toMatchObject({ version: 1, path: legacyHome, source: "legacy-database" });
  });

  it("uses LocalAppData for a new Windows install and reuses its marker", () => {
    const root = mkdtempSync(join(tmpdir(), "memos-win-home-"));
    const legacyHome = join(root, "legacy", "memos-plugin");
    const installRoot = join(root, "local", "hermes", "memos-plugin");

    const first = selectWindowsHermesRuntimeHome({ legacyHome, installRoot });
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(join(legacyHome, "config.yaml"), "viewer:\n  port: 18800\n", { flag: "a" });
    const second = selectWindowsHermesRuntimeHome({ legacyHome, installRoot });

    expect(first).toMatchObject({ root: installRoot, source: "new-install" });
    expect(second).toMatchObject({ root: installRoot, source: "marker" });
  });

  it("keeps meaningful legacy config even when neither home has a database", () => {
    const root = mkdtempSync(join(tmpdir(), "memos-win-home-"));
    const legacyHome = join(root, "legacy", "memos-plugin");
    const installRoot = join(root, "local", "hermes", "memos-plugin");
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(join(legacyHome, "config.yaml"), "viewer:\n  port: 18800\n");

    expect(selectWindowsHermesRuntimeHome({ legacyHome, installRoot }))
      .toMatchObject({ root: legacyHome, source: "legacy-data" });
  });

  it("uses the canonical Windows home when it is the only database owner", () => {
    const root = mkdtempSync(join(tmpdir(), "memos-win-home-"));
    const legacyHome = join(root, "legacy", "memos-plugin");
    const installRoot = join(root, "local", "hermes", "memos-plugin");
    mkdirSync(join(installRoot, "data"), { recursive: true });
    writeFileSync(join(installRoot, "data", "memos.db"), "canonical");

    expect(selectWindowsHermesRuntimeHome({ legacyHome, installRoot }))
      .toMatchObject({ root: installRoot, source: "canonical-database" });
  });

  it("refuses to guess when both Windows homes contain a database", () => {
    const root = mkdtempSync(join(tmpdir(), "memos-win-home-"));
    const legacyHome = join(root, "legacy", "memos-plugin");
    const installRoot = join(root, "local", "hermes", "memos-plugin");
    for (const home of [legacyHome, installRoot]) {
      mkdirSync(join(home, "data"), { recursive: true });
      writeFileSync(join(home, "data", "memos.db"), home);
    }

    expect(() => selectWindowsHermesRuntimeHome({ legacyHome, installRoot }))
      .toThrow(/both Windows Hermes runtime homes contain a database/);
  });

  it("honours an existing marker before inspecting newly-created data", () => {
    const root = mkdtempSync(join(tmpdir(), "memos-win-home-"));
    const legacyHome = join(root, "legacy", "memos-plugin");
    const installRoot = join(root, "local", "hermes", "memos-plugin");
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(
      join(installRoot, ".memos-runtime-home"),
      JSON.stringify({ version: 1, path: legacyHome, source: "legacy-config" }),
    );
    mkdirSync(join(installRoot, "data"), { recursive: true });
    writeFileSync(join(installRoot, "data", "memos.db"), "newer");

    expect(selectWindowsHermesRuntimeHome({ legacyHome, installRoot }))
      .toMatchObject({ root: legacyHome, source: "marker" });
  });
});
