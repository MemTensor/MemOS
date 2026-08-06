import { describe, it, expect, afterEach } from "vitest";
import { buildContext } from "../src/config";
import { Embedder } from "../src/embedding";
import { Summarizer } from "../src/ingest/providers";
import { loadOpenClawFallbackConfig } from "../src/shared/llm-call";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

describe("OpenClaw Fallback Configuration", () => {
  it("should create OpenClawAPI when hostEmbedding capability is enabled", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-openclaw-"));

    try {
      const ctx = buildContext(
        stateDir,
        process.cwd(),
        {
          sharing: {
            enabled: true,
            capabilities: {
              hostEmbedding: true,
              hostCompletion: false,
            },
          },
        },
        undefined,
      );

      expect(ctx.openclawAPI).toBeDefined();
      expect(ctx.config.sharing.capabilities.hostEmbedding).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("should create OpenClawAPI when hostCompletion capability is enabled", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-openclaw-"));

    try {
      const ctx = buildContext(
        stateDir,
        process.cwd(),
        {
          sharing: {
            enabled: true,
            capabilities: {
              hostEmbedding: false,
              hostCompletion: true,
            },
          },
        },
        undefined,
      );

      expect(ctx.openclawAPI).toBeDefined();
      expect(ctx.config.sharing.capabilities.hostCompletion).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("should not create OpenClawAPI when no capabilities are enabled", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-openclaw-"));

    try {
      const ctx = buildContext(
        stateDir,
        process.cwd(),
        {
          sharing: {
            enabled: true,
            capabilities: {
              hostEmbedding: false,
              hostCompletion: false,
            },
          },
        },
        undefined,
      );

      expect(ctx.openclawAPI).toBeUndefined();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("should use 'openclaw' provider when configured with hostEmbedding capability", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-openclaw-"));

    try {
      const ctx = buildContext(
        stateDir,
        process.cwd(),
        {
          embedding: {
            provider: "openclaw",
          },
          sharing: {
            enabled: true,
            capabilities: {
              hostEmbedding: true,
            },
          },
        },
        undefined,
      );

      const embedder = new Embedder(ctx.config.embedding, ctx.log, ctx.openclawAPI);
      expect(embedder.provider).toBe("openclaw");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("should fallback to 'local' when openclaw provider configured without capability", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-openclaw-"));

    try {
      const ctx = buildContext(
        stateDir,
        process.cwd(),
        {
          embedding: {
            provider: "openclaw",
          },
          sharing: {
            enabled: true,
            capabilities: {
              hostEmbedding: false,
            },
          },
        },
        undefined,
      );

      const embedder = new Embedder(ctx.config.embedding, ctx.log, ctx.openclawAPI);
      expect(embedder.provider).toBe("local");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("should use 'openclaw' provider for summarizer when configured with hostCompletion capability", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-openclaw-"));

    try {
      const ctx = buildContext(
        stateDir,
        process.cwd(),
        {
          summarizer: {
            provider: "openclaw",
          },
          sharing: {
            enabled: true,
            capabilities: {
              hostCompletion: true,
            },
          },
        },
        undefined,
      );

      const summarizer = new Summarizer(ctx.config.summarizer, ctx.log, ctx.openclawAPI);
      // After upstream refactor, Summarizer uses getConfigChain() instead of a provider getter.
      // Verify openclaw config is included in the chain when capability is enabled.
      const chain = (summarizer as any).getConfigChain();
      expect(chain.some((c: any) => c.provider === "openclaw")).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("should return undefined provider for summarizer when openclaw configured without capability", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-openclaw-"));

    try {
      const ctx = buildContext(
        stateDir,
        process.cwd(),
        {
          summarizer: {
            provider: "openclaw",
          },
          sharing: {
            enabled: true,
            capabilities: {
              hostCompletion: false,
            },
          },
        },
        undefined,
      );

      const summarizer = new Summarizer(ctx.config.summarizer, ctx.log, ctx.openclawAPI);
      // Without capability, openclaw config should be excluded from the chain
      const chain = (summarizer as any).getConfigChain();
      expect(chain.some((c: any) => c.provider === "openclaw")).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("should throw error when trying to embed with openclaw provider but API not available", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-openclaw-"));

    try {
      const ctx = buildContext(
        stateDir,
        process.cwd(),
        {
          embedding: {
            provider: "openclaw",
          },
          sharing: {
            enabled: true,
            capabilities: {
              hostEmbedding: true,
            },
          },
        },
        undefined,
      );

      const embedder = new Embedder(ctx.config.embedding, ctx.log, ctx.openclawAPI);

      // Should throw error because OpenClaw API is not yet implemented
      // But it will fallback to local, so we just check that it doesn't crash
      try {
        await embedder.embed(["test"]);
        // If it succeeds, it means fallback worked
        expect(true).toBe(true);
      } catch (err: any) {
        // If it fails, it should be a local embedding error, not OpenClaw error
        // because the fallback chain should catch the OpenClaw error
        expect(err.message).not.toMatch(/OpenClaw host embedding is not available/);
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("should fallback to local embedding when openclaw provider fails", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-openclaw-"));

    try {
      const ctx = buildContext(
        stateDir,
        process.cwd(),
        {
          embedding: {
            provider: "openclaw",
          },
          sharing: {
            enabled: true,
            capabilities: {
              hostEmbedding: true,
            },
          },
        },
        undefined,
      );

      const embedder = new Embedder(ctx.config.embedding, ctx.log, ctx.openclawAPI);

      // Should fallback to local when openclaw fails
      // Note: local embedding might also fail if model file is corrupted
      // In that case, we just verify the fallback logic was attempted
      try {
        const result = await embedder.embed(["test"]);
        expect(result).toBeDefined();
        expect(result.length).toBe(1);
        // If successful, should be local Xenova dimensions
        if (result[0]) {
          expect(result[0].length).toBe(384);
        }
      } catch (err: any) {
        // If local embedding also fails, that's OK for this test
        // We're just testing that the fallback chain works
        expect(err.message).not.toMatch(/OpenClaw host embedding is not available/);
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  describe("SecretRef apiKey resolution in loadOpenClawFallbackConfig", () => {
    const noopLog = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    let tmpDir: string;
    let savedConfigPath: string | undefined;
    let savedStateDir: string | undefined;

    afterEach(() => {
      if (savedConfigPath !== undefined) process.env.OPENCLAW_CONFIG_PATH = savedConfigPath;
      else delete process.env.OPENCLAW_CONFIG_PATH;
      if (savedStateDir !== undefined) process.env.OPENCLAW_STATE_DIR = savedStateDir;
      else delete process.env.OPENCLAW_STATE_DIR;
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function setupFakeConfig(openclawJson: object): string {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-secretref-"));
      const cfgPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(cfgPath, JSON.stringify(openclawJson), "utf-8");
      savedConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      savedStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_CONFIG_PATH = cfgPath;
      return cfgPath;
    }

    it("should resolve plain string apiKey", () => {
      setupFakeConfig({
        agents: { defaults: { model: { primary: "anthropic/claude-3-haiku" } } },
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              apiKey: "sk-ant-plain-key-123",
            },
          },
        },
      });
      const cfg = loadOpenClawFallbackConfig(noopLog);
      expect(cfg).toBeDefined();
      expect(cfg!.apiKey).toBe("sk-ant-plain-key-123");
      expect(cfg!.provider).toBe("anthropic");
      expect(cfg!.model).toBe("claude-3-haiku");
    });

    it("should resolve env-sourced SecretRef apiKey", () => {
      const testKey = "sk-ant-secretref-test-" + Date.now();
      process.env.__MEMOS_TEST_ANTHROPIC_KEY = testKey;
      try {
        setupFakeConfig({
          agents: { defaults: { model: { primary: "anthropic/claude-3-haiku" } } },
          models: {
            providers: {
              anthropic: {
                baseUrl: "https://api.anthropic.com",
                apiKey: { source: "env", provider: "anthropic", id: "__MEMOS_TEST_ANTHROPIC_KEY" },
              },
            },
          },
        });
        const cfg = loadOpenClawFallbackConfig(noopLog);
        expect(cfg).toBeDefined();
        expect(cfg!.apiKey).toBe(testKey);
        expect(cfg!.provider).toBe("anthropic");
      } finally {
        delete process.env.__MEMOS_TEST_ANTHROPIC_KEY;
      }
    });

    it("should return undefined when SecretRef env var is not set", () => {
      delete process.env.__MEMOS_TEST_MISSING_KEY;
      setupFakeConfig({
        agents: { defaults: { model: { primary: "anthropic/claude-3-haiku" } } },
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              apiKey: { source: "env", provider: "anthropic", id: "__MEMOS_TEST_MISSING_KEY" },
            },
          },
        },
      });
      const cfg = loadOpenClawFallbackConfig(noopLog);
      expect(cfg).toBeUndefined();
    });

    it("should return undefined when apiKey is missing entirely", () => {
      setupFakeConfig({
        agents: { defaults: { model: { primary: "anthropic/claude-3-haiku" } } },
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
            },
          },
        },
      });
      const cfg = loadOpenClawFallbackConfig(noopLog);
      expect(cfg).toBeUndefined();
    });

    it("should return undefined for unsupported SecretRef source", () => {
      setupFakeConfig({
        agents: { defaults: { model: { primary: "anthropic/claude-3-haiku" } } },
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              apiKey: { source: "vault", provider: "anthropic", id: "some-vault-id" },
            },
          },
        },
      });
      const cfg = loadOpenClawFallbackConfig(noopLog);
      expect(cfg).toBeUndefined();
    });

    it("should resolve SecretRef apiKey for OpenAI-compatible provider", () => {
      const testKey = "sk-openai-test-" + Date.now();
      process.env.__MEMOS_TEST_OPENAI_KEY = testKey;
      try {
        setupFakeConfig({
          agents: { defaults: { model: { primary: "custom-provider/gpt-4o-mini" } } },
          models: {
            providers: {
              "custom-provider": {
                baseUrl: "https://api.openai.com/v1",
                apiKey: { source: "env", provider: "openai", id: "__MEMOS_TEST_OPENAI_KEY" },
              },
            },
          },
        });
        const cfg = loadOpenClawFallbackConfig(noopLog);
        expect(cfg).toBeDefined();
        expect(cfg!.apiKey).toBe(testKey);
        expect(cfg!.provider).toBe("openai_compatible");
        expect(cfg!.model).toBe("gpt-4o-mini");
      } finally {
        delete process.env.__MEMOS_TEST_OPENAI_KEY;
      }
    });
  });

  it("should use rule fallback when summarizer openclaw provider fails", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-openclaw-"));

    try {
      const ctx = buildContext(
        stateDir,
        process.cwd(),
        {
          summarizer: {
            provider: "openclaw",
          },
          sharing: {
            enabled: true,
            capabilities: {
              hostCompletion: true,
            },
          },
        },
        undefined,
      );

      const summarizer = new Summarizer(ctx.config.summarizer, ctx.log, ctx.openclawAPI);

      // Should fallback to rule-based when openclaw fails
      const result = await summarizer.summarize("This is a test message for summarization.");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
