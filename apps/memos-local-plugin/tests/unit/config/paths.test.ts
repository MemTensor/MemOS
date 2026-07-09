import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { resolve as pathResolve, join } from "node:path";

import { resolveHome, expandHome } from "../../../core/config/paths.js";

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
});
