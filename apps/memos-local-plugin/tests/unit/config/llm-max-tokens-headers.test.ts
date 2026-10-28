import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, resolveConfig } from "../../../core/config/index.js";
import { FREE_FORM_CONFIG_PATHS } from "../../../core/config/defaults.js";

describe("resolveConfig llm.maxTokens + llm.headers", () => {
  it("uses an explicit allowlist for free-form config maps", () => {
    expect(FREE_FORM_CONFIG_PATHS).toEqual([
      "llm.headers",
      "l3Llm.headers",
      "skillEvolver.headers",
      "logging.channels",
    ]);
    expect(Object.isFrozen(FREE_FORM_CONFIG_PATHS)).toBe(true);

    const warnings: string[] = [];
    const cfg = resolveConfig(
      {
        logging: { channels: { "core.l2.cross-task": "debug" } },
      },
      warnings,
    );
    expect(cfg.logging.channels).toEqual({ "core.l2.cross-task": "debug" });
    expect(warnings).toEqual([]);
  });

  it("accepts llm.maxTokens and llm.headers without unknown-key warnings", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      {
        llm: {
          maxTokens: 2048,
          headers: { "User-Agent": "hermes-test", "X-Custom": "v1" },
        },
      },
      warnings,
    );
    expect(cfg.llm.maxTokens).toBe(2048);
    expect(cfg.llm.headers).toEqual({ "User-Agent": "hermes-test", "X-Custom": "v1" });
    // The free-form-map special case must not warn per header key.
    expect(warnings).toEqual([]);
  });

  it("declares llm.maxTokens with a sane default of 1024", () => {
    expect(DEFAULT_CONFIG.llm.maxTokens).toBe(1024);
    const cfg = resolveConfig({});
    expect(cfg.llm.maxTokens).toBe(1024);
  });

  it("declares llm.headers defaulting to an empty map", () => {
    expect(DEFAULT_CONFIG.llm.headers).toEqual({});
    const cfg = resolveConfig({});
    expect(cfg.llm.headers).toEqual({});
  });

  it("declares skillEvolver.maxTokens (default 4096) for the crystallizer LLM slot", () => {
    expect(DEFAULT_CONFIG.skillEvolver.maxTokens).toBe(4096);
    const cfg = resolveConfig({ skillEvolver: { maxTokens: 8192 } });
    expect(cfg.skillEvolver.maxTokens).toBe(8192);
  });

  it("declares l3Llm.maxTokens (default 4096) sharing the SkillEvolver schema", () => {
    expect(DEFAULT_CONFIG.l3Llm.maxTokens).toBe(4096);
    const cfg = resolveConfig({ l3Llm: { maxTokens: 8192 } });
    expect(cfg.l3Llm.maxTokens).toBe(8192);
  });

  it("accepts headers on skillEvolver/l3Llm slots without unknown-key warnings", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      {
        skillEvolver: { headers: { "X-Evolver": "v1" } },
        l3Llm: { headers: { "X-L3": "v2" } },
      },
      warnings,
    );
    expect(cfg.skillEvolver.headers).toEqual({ "X-Evolver": "v1" });
    expect(cfg.l3Llm.headers).toEqual({ "X-L3": "v2" });
    expect(cfg.l3Llm.maxTokens).toBe(4096);
    expect(warnings).toEqual([]);
  });

  it("declares headers defaulting to empty on the dedicated slots", () => {
    expect(DEFAULT_CONFIG.skillEvolver.headers).toEqual({});
    expect(DEFAULT_CONFIG.l3Llm.headers).toEqual({});
  });

  it("rejects out-of-range maxTokens with config_invalid", () => {
    expect(() => resolveConfig({ llm: { maxTokens: 50 } })).toThrow(/config failed schema validation/);
  });

  it("rejects non-string header values", () => {
    expect(() => resolveConfig({ llm: { headers: { "X-Bad": 42 } } })).toThrow(
      /config failed schema validation/,
    );
  });

  it("keeps unrelated llm fields untouched when maxTokens/headers are set", () => {
    const cfg = resolveConfig({
      llm: { provider: "openai_compatible", model: "deepseek-v4-flash", maxTokens: 2048 },
    });
    expect(cfg.llm.provider).toBe("openai_compatible");
    expect(cfg.llm.model).toBe("deepseek-v4-flash");
    expect(cfg.llm.temperature).toBe(0);
    expect(cfg.llm.fallbackToHost).toBe(true);
    expect(cfg.llm.timeoutMs).toBe(45_000);
    expect(cfg.llm.maxRetries).toBe(3);
  });
});
