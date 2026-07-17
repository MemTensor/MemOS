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
    expect(result.config.embedding.provider).toBe(DEFAULT_CONFIG.embedding.provider);
  });

  it("defaults OpenRouter provider routing lists to empty arrays", () => {
    const cfg = resolveConfig({});
    expect(cfg.llm.providerIgnore).toEqual([]);
    expect(cfg.llm.providerOrder).toEqual([]);
    expect(cfg.skillEvolver.providerIgnore).toEqual([]);
    expect(cfg.skillEvolver.providerOrder).toEqual([]);
    expect(cfg.l3Llm.providerIgnore).toEqual([]);
    expect(cfg.l3Llm.providerOrder).toEqual([]);
    expect(cfg.embedding.providerIgnore).toEqual([]);
    expect(cfg.embedding.providerOrder).toEqual([]);
    expect(cfg.llm.openRouter).toBe(false);
    expect(cfg.skillEvolver.openRouter).toBe(false);
    expect(cfg.l3Llm.openRouter).toBe(false);
    expect(cfg.embedding.openRouter).toBe(false);
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

  it("accepts OpenRouter provider routing fields on LLM config branches", () => {
    const cfg = resolveConfig({
      llm: {
        providerIgnore: ["together", "deepinfra"],
        providerOrder: ["google", "anthropic"],
        openRouter: true,
      },
      skillEvolver: {
        providerIgnore: ["novita"],
        providerOrder: ["openai"],
        openRouter: true,
      },
      l3Llm: {
        providerIgnore: ["novita"],
        providerOrder: ["openai"],
        openRouter: true,
      },
      embedding: {
        providerIgnore: ["deepinfra"],
        providerOrder: ["openai"],
        openRouter: true,
      },
    });
    expect(cfg.llm.providerIgnore).toEqual(["together", "deepinfra"]);
    expect(cfg.llm.providerOrder).toEqual(["google", "anthropic"]);
    expect(cfg.skillEvolver.providerIgnore).toEqual(["novita"]);
    expect(cfg.skillEvolver.providerOrder).toEqual(["openai"]);
    expect(cfg.l3Llm.providerIgnore).toEqual(["novita"]);
    expect(cfg.l3Llm.providerOrder).toEqual(["openai"]);
    expect(cfg.embedding.providerIgnore).toEqual(["deepinfra"]);
    expect(cfg.embedding.providerOrder).toEqual(["openai"]);
    expect(cfg.llm.openRouter).toBe(true);
    expect(cfg.skillEvolver.openRouter).toBe(true);
    expect(cfg.l3Llm.openRouter).toBe(true);
    expect(cfg.embedding.openRouter).toBe(true);
  });

  it("accepts OpenRouter reasoning effort aliases", () => {
    const cfg = resolveConfig({
      llm: { reasoning: { effort: "xhigh" } },
    });
    expect(cfg.llm.reasoning?.effort).toBe("xhigh");
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

  it("defaults lightweight memory mode on and accepts explicit opt-out", () => {
    const base = resolveConfig({});
    expect(base.algorithm.lightweightMemory.enabled).toBe(true);

    const cfg = resolveConfig({
      algorithm: { lightweightMemory: { enabled: false } },
    });
    expect(cfg.algorithm.lightweightMemory.enabled).toBe(false);
  });

  it("does not expose embedding dimensions as user config", () => {
    const cfg = resolveConfig({
      embedding: {
        provider: "openai_compatible",
        model: "bge-m3",
        endpoint: "https://example.test/v1",
      },
    });
    expect("dimensions" in cfg.embedding).toBe(false);
  });

  it("ignores legacy/manual embedding dimensions", () => {
    const cfg = resolveConfig({
      embedding: {
        provider: "openai_compatible",
        model: "bge-m3",
        dimensions: 1024,
      },
    });
    expect("dimensions" in cfg.embedding).toBe(false);
  });

  // ─── Issue #1929 — vectorScanMaxAgeMs contract ──────────────────────
  // The schema must reject obviously bad values (negative, larger than
  // a year, or non-numbers) so a "dirty" `PATCH /api/v1/config` cannot
  // poison the on-disk YAML. A subsequent `GET /api/v1/config` therefore
  // always returns a value in [0, 31_536_000_000] (the default 0 stays
  // because the rejected patch never reaches `writer.ts`'s atomic
  // rename — see `core/config/writer.ts::patchConfig`).
  describe("retrieval.vectorScanMaxAgeMs", () => {
    const MAX_MS = 31_536_000_000;

    it("defaults to 0 (no time-window bound) on a bare config", () => {
      const cfg = resolveConfig({});
      expect(cfg.algorithm.retrieval.vectorScanMaxAgeMs).toBe(0);
    });

    it.each([
      ["one day", 86_400_000],
      ["thirty days", 30 * 86_400_000],
      ["max", MAX_MS],
      ["zero", 0],
    ])("accepts %s (%d ms)", (_label, value) => {
      const cfg = resolveConfig({
        algorithm: { retrieval: { vectorScanMaxAgeMs: value } },
      });
      expect(cfg.algorithm.retrieval.vectorScanMaxAgeMs).toBe(value);
    });

    it.each([
      ["negative_1", -1],
      ["negative_60s", -60_000],
      ["negative_one_day", -86_400_000],
      ["max_plus_1", MAX_MS + 1],
      ["max_plus_one_day", MAX_MS + 86_400_000],
      ["hundred_x_max", MAX_MS * 100],
    ])("rejects out-of-range value (%s)", (_label, value) => {
      expect(() =>
        resolveConfig({ algorithm: { retrieval: { vectorScanMaxAgeMs: value } } }),
      ).toThrow(/schema validation/);
    });

    it.each([
      ["string_number", "100"],
      ["string_text", "abc"],
      ["none_value", null],
      ["dict_value", { x: 1 }],
      ["list_value", [1, 2, 3]],
      ["nan_string", "NaN"],
      ["inf_string", "Infinity"],
      ["bool_true", true],
      ["bool_false", false],
    ])("rejects invalid type (%s)", (_label, value) => {
      expect(() =>
        resolveConfig({
          algorithm: {
            retrieval: { vectorScanMaxAgeMs: value as unknown as number },
          },
        }),
      ).toThrow(/schema validation/);
    });
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
