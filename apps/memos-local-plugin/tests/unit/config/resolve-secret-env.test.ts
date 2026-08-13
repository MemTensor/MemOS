import { afterEach, describe, expect, it } from "vitest";

import { resolveConfig } from "../../../core/config/index.js";
import { SECRET_FIELD_PATHS } from "../../../core/config/defaults.js";

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
    const cfg = resolveConfig({ llm: { apiKey: "__memos_secret__" } });
    expect(cfg.llm.apiKey).toBe("sk-mask-resolved");
  });

  it("resolves empty string secret fields from env", () => {
    process.env.OPENCODE_ZEN_API_KEY = "sk-empty-resolved";
    const cfg = resolveConfig({ llm: { apiKey: "" } });
    expect(cfg.llm.apiKey).toBe("sk-empty-resolved");
  });

  it("uses per-path env conventions — embedding gets EMBEDDING_API_KEY, never an LLM key", () => {
    process.env.OPENCODE_GO_API_KEY = "sk-llm";
    process.env.EMBEDDING_API_KEY = "sk-embed";
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
    for (const dotted of SECRET_FIELD_PATHS) {
      const keys = dotted.split(".");
      let cursor: unknown = cfg;
      for (const k of keys) {
        cursor = (cursor as Record<string, unknown>)[k];
      }
      if (dotted === "embedding.apiKey") {
        expect(cursor).toBe("sk-embed");
      } else if (dotted.endsWith("apiKey")) {
        expect(cursor).toBe("sk-llm");
      } else {
        expect(cursor).toBe("__memos_secret__");
      }
    }
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
    process.env.OPENCODE_GO_API_KEY = "sk-llm";
    const raw = { llm: { apiKey: "__memos_secret__" } };
    const cfg = resolveConfig(raw);
    expect(cfg.llm.apiKey).toBe("sk-llm");
    expect(raw.llm.apiKey).toBe("__memos_secret__");
  });
});
