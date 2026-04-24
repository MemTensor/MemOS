import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig, resolveConfig, resolveHome } from "../../../core/config/index.js";
import { makeTmpHome } from "../../helpers/tmp-home.js";

describe("config/loadConfig", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it("returns defaults with a warning when no config file exists", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    // No config.yaml written → loadConfig returns defaults + warning.
    await fs.rm(ctx.home.configFile, { force: true });
    const result = await loadConfig(ctx.home);
    expect(result.fromDisk).toBe(false);
    expect(result.warnings.some((w) => w.includes("not found"))).toBe(true);
    expect(result.config.viewer.port).toBe(DEFAULT_CONFIG.viewer.port);
    expect(result.config.embedding.dimensions).toBe(DEFAULT_CONFIG.embedding.dimensions);
  });

  it("merges YAML over defaults and preserves unspecified branches", async () => {
    const yaml = `
viewer:
  port: 19000
llm:
  provider: openai_compatible
  model: gpt-4o-mini
algorithm:
  reward:
    gamma: 0.5
`;
    const ctx = await makeTmpHome({ agent: "openclaw", configYaml: yaml });
    cleanup = ctx.cleanup;
    expect(ctx.config.viewer.port).toBe(19000);
    expect(ctx.config.viewer.bindHost).toBe(DEFAULT_CONFIG.viewer.bindHost);
    expect(ctx.config.llm.provider).toBe("openai_compatible");
    expect(ctx.config.llm.model).toBe("gpt-4o-mini");
    expect(ctx.config.algorithm.reward.gamma).toBe(0.5);
    expect(ctx.config.algorithm.skill.minSupport).toBe(DEFAULT_CONFIG.algorithm.skill.minSupport);
  });

  it("rejects invalid types with a helpful error", async () => {
    // Don't use makeTmpHome here — it would eagerly loadConfig and throw
    // before we can capture it. Lay out the dir manually instead.
    const { mkdtemp, writeFile, rm, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "memos-invalid-"));
    const prev = process.env["MEMOS_HOME"];
    process.env["MEMOS_HOME"] = root;
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(join(root, "config.yaml"), `viewer:\n  port: "not a number"\n`, "utf8");
    cleanup = async () => {
      if (prev === undefined) delete process.env["MEMOS_HOME"];
      else process.env["MEMOS_HOME"] = prev;
      await rm(root, { recursive: true, force: true });
    };
    await expect(loadConfig(resolveHome("openclaw"))).rejects.toThrow(/schema validation/);
  });

  it("keeps unknown keys (forward-compatible) and emits a warning", async () => {
    const yaml = `
mysteryFutureField: 42
viewer:
  port: 18910
`;
    const ctx = await makeTmpHome({ agent: "openclaw", configYaml: yaml });
    cleanup = ctx.cleanup;
    const result = await loadConfig(ctx.home);
    expect(result.fromDisk).toBe(true);
    expect(result.warnings.some((w) => w.includes("mysteryFutureField"))).toBe(true);
    expect((result.config as Record<string, unknown>)["mysteryFutureField"]).toBe(42);
  });

  it("resolveConfig works with arbitrary objects (no disk)", () => {
    const cfg = resolveConfig({ viewer: { port: 1234 }, llm: { temperature: 0.7 } });
    expect(cfg.viewer.port).toBe(1234);
    expect(cfg.llm.temperature).toBe(0.7);
    expect(cfg.algorithm.skill.minSupport).toBe(DEFAULT_CONFIG.algorithm.skill.minSupport);
  });
});

describe("config/loadConfig MEMOS_HOME override", () => {
  const SAVED = process.env["MEMOS_HOME"];
  beforeEach(() => { delete process.env["MEMOS_HOME"]; });
  afterEach(() => { if (SAVED === undefined) delete process.env["MEMOS_HOME"]; else process.env["MEMOS_HOME"] = SAVED; });

  it("respects MEMOS_HOME at the resolveHome level", () => {
    process.env["MEMOS_HOME"] = "/tmp/forced/h1";
    const home = resolveHome("openclaw");
    expect(home.configFile).toBe(join("/tmp/forced/h1", "config.yaml"));
  });
});
