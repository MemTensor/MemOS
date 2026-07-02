import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseOpenClawConfig, readOpenClawConfig } from "../src/shared/openclaw-config";
import { loadOpenClawFallbackConfig } from "../src/shared/llm-call";

describe("openclaw.json JSON5 tolerance (issue #1543)", () => {
  const noopLog = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  let tmpDir: string | undefined;
  let savedConfigPath: string | undefined;
  let savedStateDir: string | undefined;

  afterEach(() => {
    if (savedConfigPath !== undefined) process.env.OPENCLAW_CONFIG_PATH = savedConfigPath;
    else delete process.env.OPENCLAW_CONFIG_PATH;
    if (savedStateDir !== undefined) process.env.OPENCLAW_STATE_DIR = savedStateDir;
    else delete process.env.OPENCLAW_STATE_DIR;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    savedConfigPath = undefined;
    savedStateDir = undefined;
  });

  function writeConfig(raw: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-json5-"));
    const cfgPath = path.join(tmpDir, "openclaw.json");
    fs.writeFileSync(cfgPath, raw, "utf-8");
    savedConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    savedStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_CONFIG_PATH = cfgPath;
    return cfgPath;
  }

  describe("parseOpenClawConfig", () => {
    it("parses strict JSON identical to JSON.parse", () => {
      const raw = '{"tools":{"allow":["core:read","core:write"]}}';
      expect(parseOpenClawConfig(raw)).toEqual({
        tools: { allow: ["core:read", "core:write"] },
      });
    });

    it("accepts line comments (// ...) — the exact case from issue #1543", () => {
      const raw = `{
        // this is my openclaw config
        "tools": {
          "allow": [
            "core:read",
            "core:write" // last tool
          ]
        }
      }`;
      const cfg = parseOpenClawConfig(raw) as any;
      expect(cfg.tools.allow).toEqual(["core:read", "core:write"]);
    });

    it("accepts block comments (/* ... */)", () => {
      const raw = `{
        /* header */
        "tools": { "allow": ["core:read"] }
      }`;
      const cfg = parseOpenClawConfig(raw) as any;
      expect(cfg.tools.allow).toEqual(["core:read"]);
    });

    it("accepts single-quoted strings", () => {
      const raw = `{ 'tools': { 'allow': ['core:read', 'core:write'] } }`;
      const cfg = parseOpenClawConfig(raw) as any;
      expect(cfg.tools.allow).toEqual(["core:read", "core:write"]);
    });

    it("accepts trailing commas", () => {
      const raw = `{ "tools": { "allow": ["core:read", "core:write",], }, }`;
      const cfg = parseOpenClawConfig(raw) as any;
      expect(cfg.tools.allow).toEqual(["core:read", "core:write"]);
    });

    it("accepts unquoted identifier keys", () => {
      const raw = `{ tools: { allow: ["core:read"] } }`;
      const cfg = parseOpenClawConfig(raw) as any;
      expect(cfg.tools.allow).toEqual(["core:read"]);
    });

    it("still throws on malformed JSON5", () => {
      expect(() => parseOpenClawConfig("{ this is not valid")).toThrow();
    });
  });

  describe("readOpenClawConfig", () => {
    it("reads a JSON5 file from disk", () => {
      const cfgPath = writeConfig(`{
        // comment
        "tools": { "allow": ["a", "b"] }
      }`);
      expect(readOpenClawConfig(cfgPath)).toEqual({ tools: { allow: ["a", "b"] } });
    });
  });

  describe("loadOpenClawFallbackConfig", () => {
    it("loads a JSON5 openclaw.json with comments and mixed quoting", () => {
      const testKey = "sk-json5-test-" + Date.now();
      process.env.__MEMOS_TEST_JSON5_KEY = testKey;
      try {
        writeConfig(`{
          // top-level comment
          agents: {
            defaults: {
              model: {
                primary: 'anthropic/claude-3-haiku', // trailing comment
              },
            },
          },
          models: {
            providers: {
              anthropic: {
                baseUrl: "https://api.anthropic.com",
                /* block comment */
                apiKey: { source: 'env', provider: 'anthropic', id: '__MEMOS_TEST_JSON5_KEY' },
              },
            },
          },
        }`);
        const cfg = loadOpenClawFallbackConfig(noopLog);
        expect(cfg).toBeDefined();
        expect(cfg!.apiKey).toBe(testKey);
        expect(cfg!.provider).toBe("anthropic");
        expect(cfg!.model).toBe("claude-3-haiku");
      } finally {
        delete process.env.__MEMOS_TEST_JSON5_KEY;
      }
    });
  });

  describe("tools.allow patch (simulates index.ts:354-380)", () => {
    /**
     * Reproduce the exact flow from apps/memos-local-openclaw/index.ts that
     * failed pre-fix with "SyntaxError: Expected double-quoted property name
     * in JSON at position 2222" when the user's openclaw.json contained
     * comments. We only assert the read step no longer throws.
     */
    function readAllowFromRaw(raw: string): string[] | undefined {
      const cfg = parseOpenClawConfig(raw) as any;
      return cfg?.tools?.allow;
    }

    it("does not crash on a JSON5 openclaw.json with '//' comments", () => {
      const raw = `{
        // memory tools
        "tools": {
          "allow": [
            "core:read",
            "core:write" // enable writes
          ]
        }
      }`;
      expect(() => readAllowFromRaw(raw)).not.toThrow();
      expect(readAllowFromRaw(raw)).toEqual(["core:read", "core:write"]);
    });

    it("patch regex still works when file uses double-quoted strings alongside comments", () => {
      const raw = `{
        // top comment
        "tools": {
          "allow": [
            "core:read",
            "core:write"
          ]
        }
      }`;
      const allow = readAllowFromRaw(raw)!;
      const lastEntry = JSON.stringify(allow[allow.length - 1]);
      const patched = raw.replace(
        new RegExp(`(${lastEntry})(\\s*\\])`),
        `$1,\n      "group:plugins"$2`,
      );
      expect(patched).not.toBe(raw);
      expect(patched).toContain('"group:plugins"');
      // The comment must be preserved.
      expect(patched).toContain("// top comment");
      // The patched file must still parse (as JSON5).
      const reparsed = parseOpenClawConfig(patched) as any;
      expect(reparsed.tools.allow).toContain("group:plugins");
    });
  });
});
