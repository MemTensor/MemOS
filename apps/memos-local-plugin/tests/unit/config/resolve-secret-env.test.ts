import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, resolveConfig } from "../../../core/config/index.js";
import { SECRET_FIELD_PATHS } from "../../../core/config/defaults.js";
import { makeTmpHome } from "../../helpers/tmp-home.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveConfig secret env fallback", () => {
  it("expands allowlisted ${ENV_VAR} references in secret fields", () => {
    process.env.MY_LLM_API_KEY = "sk-env-expanded";
    const cfg = resolveConfig({ llm: { apiKey: "${MY_LLM_API_KEY}" } });
    expect(cfg.llm.apiKey).toBe("sk-env-expanded");
  });

  it("resolves the __memos_secret__ mask sentinel from env", () => {
    process.env.OPENCODE_GO_API_KEY = "sk-mask-resolved";
    const cfg = resolveConfig({
      llm: {
        provider: "openai_compatible",
        endpoint: "https://opencode.ai/zen/go/v1",
        apiKey: "__memos_secret__",
      },
    });
    expect(cfg.llm.apiKey).toBe("sk-mask-resolved");
  });

  it("resolves empty string secret fields from env", () => {
    process.env.OPENCODE_ZEN_API_KEY = "sk-empty-resolved";
    const cfg = resolveConfig({
      llm: {
        provider: "openai_compatible",
        endpoint: "https://opencode.ai/zen/v1",
        apiKey: "",
      },
    });
    expect(cfg.llm.apiKey).toBe("sk-empty-resolved");
  });

  it("does not send an OpenCode key to a different LLM provider", () => {
    delete process.env.LLM_API_KEY;
    process.env.OPENCODE_GO_API_KEY = "sk-opencode-only";
    process.env.OPENCODE_ZEN_API_KEY = "sk-opencode-zen-only";

    const cfg = resolveConfig({
      llm: {
        provider: "anthropic",
        endpoint: "https://api.anthropic.com",
        apiKey: "__memos_secret__",
      },
    });

    expect(cfg.llm.apiKey).toBe("__memos_secret__");
  });

  it("keeps OpenCode Go and Zen endpoint keys isolated", () => {
    delete process.env.LLM_API_KEY;
    process.env.OPENCODE_GO_API_KEY = "sk-go-only";
    delete process.env.OPENCODE_ZEN_API_KEY;

    const zenConfig = resolveConfig({
      llm: {
        provider: "openai_compatible",
        endpoint: "https://opencode.ai/zen/v1",
        apiKey: "__memos_secret__",
      },
    });
    expect(zenConfig.llm.apiKey).toBe("__memos_secret__");

    delete process.env.OPENCODE_GO_API_KEY;
    process.env.OPENCODE_ZEN_API_KEY = "sk-zen-only";
    const goConfig = resolveConfig({
      llm: {
        provider: "openai_compatible",
        endpoint: "https://opencode.ai/zen/go/v1",
        apiKey: "__memos_secret__",
      },
    });
    expect(goConfig.llm.apiKey).toBe("__memos_secret__");
  });

  it("does not warn for intentionally empty optional secrets", () => {
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    delete process.env.OPENCODE_ZEN_API_KEY;
    delete process.env.HUB_TEAM_TOKEN;
    const warnings: string[] = [];

    resolveConfig(
      {
        embedding: { provider: "local", apiKey: "" },
        llm: { provider: "host", apiKey: "" },
        hub: { enabled: false, teamToken: "" },
      },
      warnings,
    );

    expect(warnings).toEqual([]);
  });

  it("restores a masked disk secret when config is loaded again", async () => {
    process.env.LLM_API_KEY = "sk-restart-restored";
    const ctx = await makeTmpHome({
      agent: "hermes",
      configYaml: [
        "version: 1",
        "llm:",
        "  provider: openai_compatible",
        "  endpoint: https://example.com/v1",
        "  apiKey: __memos_secret__",
      ].join("\n"),
    });

    try {
      const restarted = await loadConfig(ctx.home, "hermes");
      expect(restarted.fromDisk).toBe(true);
      expect(restarted.config.llm.apiKey).toBe("sk-restart-restored");
    } finally {
      await ctx.cleanup();
    }
  });

  it("uses per-path env conventions — every secret path resolves from its own env var", () => {
    // Every path has its own environment variable and never silently borrows
    // a provider-specific key intended for another config slot.
    process.env.LLM_API_KEY = "sk-llm";
    process.env.EMBEDDING_API_KEY = "sk-embed";
    process.env.L3_LLM_API_KEY = "sk-l3";
    process.env.SKILL_EVOLVER_API_KEY = "sk-skill";
    process.env.HUB_TEAM_TOKEN = "sk-team";
    process.env.HUB_USER_TOKEN = "sk-user";
    const raw: Record<string, unknown> = {};
    for (const dotted of SECRET_FIELD_PATHS) {
      const keys = dotted.split(".");
      let cursor = raw;
      for (let i = 0; i < keys.length - 1; i++) {
        cursor[keys[i]!] = cursor[keys[i]!] ?? {};
        cursor = cursor[keys[i]!] as Record<string, unknown>;
      }
      cursor[keys[keys.length - 1]!] = "__memos_secret__";
    }
    const cfg = resolveConfig(raw);
    const expected: Record<string, string> = {
      "embedding.apiKey": "sk-embed",
      "llm.apiKey": "sk-llm",
      "l3Llm.apiKey": "sk-l3",
      "skillEvolver.apiKey": "sk-skill",
      "hub.teamToken": "sk-team",
      "hub.userToken": "sk-user",
    };
    for (const dotted of SECRET_FIELD_PATHS) {
      const keys = dotted.split(".");
      let cursor: unknown = cfg;
      for (const k of keys) {
        cursor = (cursor as Record<string, unknown>)[k];
      }
      expect(cursor).toBe(expected[dotted]);
    }
  });

  it("resolves masked hub tokens from HUB_TEAM_TOKEN / HUB_USER_TOKEN", () => {
    // Regression: previously the mask/empty path only ran when `leaf ===
    // 'apiKey'`, so hub.teamToken / hub.userToken masked by
    // maskSecrets() were silently left unresolved and hub auth failed
    // exactly like the LLM auth bug in #2245.
    process.env.HUB_TEAM_TOKEN = "sk-team-mask";
    process.env.HUB_USER_TOKEN = "sk-user-empty";
    const cfg = resolveConfig({
      hub: { teamToken: "__memos_secret__", userToken: "" },
    });
    expect(cfg.hub.teamToken).toBe("sk-team-mask");
    expect(cfg.hub.userToken).toBe("sk-user-empty");
  });

  it("does not fall back to OPENCODE_GO/ZEN for l3Llm.apiKey", () => {
    // Per-component overrides must not silently inherit the primary
    // provider's key: l3-llm and skill-evolver are frequently pointed
    // at a different provider than the shared llm settings.
    process.env.OPENCODE_GO_API_KEY = "sk-llm";
    process.env.OPENCODE_ZEN_API_KEY = "sk-zen";
    delete process.env.L3_LLM_API_KEY;
    const cfg = resolveConfig({ l3Llm: { apiKey: "__memos_secret__" } });
    expect(cfg.l3Llm.apiKey).toBe("__memos_secret__");
  });

  it("does not fall back to OPENCODE_GO/ZEN for skillEvolver.apiKey", () => {
    process.env.OPENCODE_GO_API_KEY = "sk-llm";
    process.env.OPENCODE_ZEN_API_KEY = "sk-zen";
    delete process.env.SKILL_EVOLVER_API_KEY;
    const cfg = resolveConfig({ skillEvolver: { apiKey: "__memos_secret__" } });
    expect(cfg.skillEvolver.apiKey).toBe("__memos_secret__");
  });

  it("warns when an explicit ${VAR} reference cannot be resolved", () => {
    // Without a warning the user sees auth failures with no actionable
    // hint; the whole point of the read-side resolver is to make config
    // → env misconfiguration debuggable.
    delete process.env.MISSING_LLM_API_KEY;
    const warnings: string[] = [];
    const cfg = resolveConfig({ llm: { apiKey: "${MISSING_LLM_API_KEY}" } }, warnings);
    expect(cfg.llm.apiKey).toBe("${MISSING_LLM_API_KEY}");
    expect(warnings.some((w) => w.includes("MISSING_LLM_API_KEY") && w.includes("not set"))).toBe(
      true,
    );
  });

  it("warns when a masked apiKey has no backing env var", () => {
    delete process.env.LLM_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    delete process.env.OPENCODE_ZEN_API_KEY;
    const warnings: string[] = [];
    const cfg = resolveConfig({ llm: { apiKey: "__memos_secret__" } }, warnings);
    expect(cfg.llm.apiKey).toBe("__memos_secret__");
    expect(warnings.some((w) => w.includes("llm.apiKey") && w.includes("not set"))).toBe(true);
  });

  it("resolves hub tokens via explicit ${VAR} references", () => {
    process.env.HUB_TEAM_TOKEN = "sk-hub-token";
    const cfg = resolveConfig({ hub: { teamToken: "${HUB_TEAM_TOKEN}" } });
    expect(cfg.hub.teamToken).toBe("sk-hub-token");
  });

  it("does not fall back to generic keys when an explicit ${VAR} is unset", () => {
    process.env.OPENCODE_GO_API_KEY = "sk-llm";
    process.env.OPENCODE_ZEN_API_KEY = "sk-zen";
    const cfg = resolveConfig({ llm: { apiKey: "${MY_LLM_API_KEY}" } });
    expect(cfg.llm.apiKey).toBe("${MY_LLM_API_KEY}");
  });

  it("warns and skips expansion for non-allowlisted ${VAR} names", () => {
    process.env.HOME = "/home/test";
    const warnings: string[] = [];
    const cfg = resolveConfig({ llm: { apiKey: "${HOME}" } }, warnings);
    expect(cfg.llm.apiKey).toBe("${HOME}");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("not allowlisted");
  });

  it("leaves real (non-placeholder) values untouched", () => {
    const cfg = resolveConfig({ llm: { apiKey: "sk-real-value" } });
    expect(cfg.llm.apiKey).toBe("sk-real-value");
  });

  it("leaves placeholders untouched when no env var is set", () => {
    delete process.env.LLM_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    delete process.env.OPENCODE_ZEN_API_KEY;
    const cfg = resolveConfig({ llm: { apiKey: "__memos_secret__" } });
    expect(cfg.llm.apiKey).toBe("__memos_secret__");
  });

  it("never mutates the caller's raw config object", () => {
    process.env.LLM_API_KEY = "sk-llm";
    const raw = { llm: { apiKey: "__memos_secret__" } };
    const cfg = resolveConfig(raw);
    expect(cfg.llm.apiKey).toBe("sk-llm");
    expect(raw.llm.apiKey).toBe("__memos_secret__");
  });
});
