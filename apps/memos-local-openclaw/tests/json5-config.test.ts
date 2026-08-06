import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseJsonOrJson5,
  parseJson5,
  normalizeJson5,
  Json5ParseError,
} from "../src/shared/json5";
import { loadOpenClawFallbackConfig } from "../src/shared/llm-call";

/**
 * Regression coverage for issue #1543:
 *   openclaw.json is JSON5; the plugin tried to read it with strict JSON.parse,
 *   so any user who had a `//` comment in tools.allow broke initialization.
 */
describe("parseJsonOrJson5 — JSON5 features used by openclaw.json", () => {
  it("parses plain strict JSON unchanged", () => {
    const obj = parseJsonOrJson5(JSON.stringify({ a: 1, b: [1, 2], c: "x" }));
    expect(obj).toEqual({ a: 1, b: [1, 2], c: "x" });
  });

  it("parses JSON with line comments (the exact issue #1543 case)", () => {
    const text = `{
      "tools": {
        // these are the allowed tool groups
        "allow": [
          "group:builtin", // built-in tools
          "group:plugins"  // plugin-provided tools
        ]
      }
    }`;
    const obj = parseJsonOrJson5(text) as any;
    expect(obj.tools.allow).toEqual(["group:builtin", "group:plugins"]);
  });

  it("parses JSON with block comments", () => {
    const text = `{
      /* header comment */
      "models": {
        "providers": {
          /* anthropic provider config */
          "anthropic": { "baseUrl": "https://api.anthropic.com" }
        }
      }
    }`;
    const obj = parseJsonOrJson5(text) as any;
    expect(obj.models.providers.anthropic.baseUrl).toBe(
      "https://api.anthropic.com",
    );
  });

  it("parses trailing commas in arrays and objects", () => {
    const text = `{
      "tools": {
        "allow": ["a", "b", "c",],
      },
    }`;
    const obj = parseJsonOrJson5(text) as any;
    expect(obj.tools.allow).toEqual(["a", "b", "c"]);
  });

  it("parses single-quoted strings", () => {
    const text = `{
      'name': 'memos-local',
      "value": 'has "embedded double" quotes inside'
    }`;
    const obj = parseJsonOrJson5(text) as any;
    expect(obj.name).toBe("memos-local");
    expect(obj.value).toBe('has "embedded double" quotes inside');
  });

  it("parses unquoted identifier keys", () => {
    const text = `{
      tools: { allow: ["x"] },
      agents: { defaults: { model: { primary: "anthropic/claude-3-haiku" } } }
    }`;
    const obj = parseJsonOrJson5(text) as any;
    expect(obj.tools.allow).toEqual(["x"]);
    expect(obj.agents.defaults.model.primary).toBe("anthropic/claude-3-haiku");
  });

  it("handles UTF-8 BOM", () => {
    const text = "﻿" + JSON.stringify({ ok: true });
    expect(parseJsonOrJson5(text)).toEqual({ ok: true });
  });

  it("does not strip `//` that appears inside string literals", () => {
    const text = `{
      "url": "https://api.anthropic.com",
      "note": "see https://example.com/docs#path // not a comment"
    }`;
    const obj = parseJsonOrJson5(text) as any;
    expect(obj.url).toBe("https://api.anthropic.com");
    expect(obj.note).toBe(
      "see https://example.com/docs#path // not a comment",
    );
  });

  it("does not strip `/*` that appears inside string literals", () => {
    const text = `{ "tip": "use /* and */ for block comments" }`;
    const obj = parseJsonOrJson5(text) as any;
    expect(obj.tip).toBe("use /* and */ for block comments");
  });

  it("throws Json5ParseError on truly malformed input", () => {
    expect(() => parseJson5("{ not_json: , }")).toThrow(Json5ParseError);
  });

  it("normalizeJson5 yields strict JSON that JSON.parse can read", () => {
    const text = `{
      // header
      a: 1,
      b: 'two',
      c: [3, 4,],
    }`;
    const out = normalizeJson5(text);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toEqual({ a: 1, b: "two", c: [3, 4] });
  });
});

describe("loadOpenClawFallbackConfig with JSON5 openclaw.json (issue #1543)", () => {
  let tmpDir: string | undefined;
  let savedConfigPath: string | undefined;
  let savedStateDir: string | undefined;

  afterEach(() => {
    if (savedConfigPath !== undefined) process.env.OPENCLAW_CONFIG_PATH = savedConfigPath;
    else delete process.env.OPENCLAW_CONFIG_PATH;
    if (savedStateDir !== undefined) process.env.OPENCLAW_STATE_DIR = savedStateDir;
    else delete process.env.OPENCLAW_STATE_DIR;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    savedConfigPath = undefined;
    savedStateDir = undefined;
    tmpDir = undefined;
  });

  function writeRawConfig(text: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-json5-"));
    const cfgPath = path.join(tmpDir, "openclaw.json");
    fs.writeFileSync(cfgPath, text, "utf-8");
    savedConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    savedStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_CONFIG_PATH = cfgPath;
    return cfgPath;
  }

  const noopLog = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  it("loads fallback config when openclaw.json contains line comments", () => {
    writeRawConfig(`{
      // top-level config
      "agents": {
        "defaults": {
          "model": { "primary": "anthropic/claude-3-haiku" }
        }
      },
      "models": {
        "providers": {
          // anthropic provider
          "anthropic": {
            "baseUrl": "https://api.anthropic.com",
            "apiKey": "sk-ant-test"
          }
        }
      }
    }`);
    const cfg = loadOpenClawFallbackConfig(noopLog);
    expect(cfg).toBeDefined();
    expect(cfg!.apiKey).toBe("sk-ant-test");
    expect(cfg!.provider).toBe("anthropic");
    expect(cfg!.model).toBe("claude-3-haiku");
  });

  it("loads fallback config when openclaw.json mixes single + double quotes", () => {
    writeRawConfig(`{
      'agents': { 'defaults': { 'model': { 'primary': 'anthropic/claude-3-haiku' } } },
      "models": {
        "providers": {
          "anthropic": { "baseUrl": 'https://api.anthropic.com', apiKey: 'sk-ant-test' }
        }
      }
    }`);
    const cfg = loadOpenClawFallbackConfig(noopLog);
    expect(cfg).toBeDefined();
    expect(cfg!.apiKey).toBe("sk-ant-test");
  });

  it("loads fallback config when openclaw.json has trailing commas", () => {
    writeRawConfig(`{
      "agents": { "defaults": { "model": { "primary": "anthropic/claude-3-haiku" } } },
      "models": {
        "providers": {
          "anthropic": { "baseUrl": "https://api.anthropic.com", "apiKey": "sk-ant-test", },
        },
      },
    }`);
    const cfg = loadOpenClawFallbackConfig(noopLog);
    expect(cfg).toBeDefined();
    expect(cfg!.apiKey).toBe("sk-ant-test");
  });
});
