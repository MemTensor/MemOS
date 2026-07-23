import { afterEach, describe, expect, it, vi } from "vitest";

import { makeTmpHome, type TmpHomeContext } from "../../helpers/tmp-home.js";
import type {
  LlmCallOptions,
  LlmClient,
  LlmClientStats,
  LlmConfig,
  LlmMessage,
  LlmProviderName,
} from "../../../core/llm/types.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

const capturedLlmConfigs: LlmConfig[] = [];

function fakeLlmClient(config: LlmConfig): LlmClient {
  return {
    provider: config.provider as LlmProviderName,
    model: config.model,
    canStream: false,
    async complete(_messages: LlmMessage[] | string, _opts?: LlmCallOptions) {
      return {
        text: "{}",
        provider: config.provider as LlmProviderName,
        model: config.model,
        servedBy: config.provider as LlmProviderName,
        durationMs: 0,
      };
    },
    async completeJson<T>() {
      return {
        value: {} as T,
        raw: "{}",
        provider: config.provider as LlmProviderName,
        model: config.model,
        servedBy: config.provider as LlmProviderName,
        durationMs: 0,
      };
    },
    async *stream() {
      yield { delta: "", done: true };
    },
    stats(): LlmClientStats {
      return {
        requests: 0,
        hostFallbacks: 0,
        failures: 0,
        retries: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        lastOkAt: null,
        lastError: null,
        lastStatus: null,
      };
    },
    resetStats() {},
    async close() {},
  };
}

vi.mock("../../../core/llm/client.js", () => ({
  createLlmClient: (config: LlmConfig) => {
    capturedLlmConfigs.push(config);
    return fakeLlmClient(config);
  },
}));

describe("bootstrapMemoryCore dedicated LLM config", () => {
  let home: TmpHomeContext | null = null;
  let core: MemoryCore | null = null;

  afterEach(async () => {
    if (core) await core.shutdown();
    if (home) await home.cleanup();
    core = null;
    home = null;
    capturedLlmConfigs.length = 0;
    vi.resetModules();
  });

  it("forwards OpenRouter provider routing to dedicated LLM clients", async () => {
    const { bootstrapMemoryCore } = await import("../../../core/pipeline/memory-core.js");
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: `
llm:
  provider: local_only
  model: main
skillEvolver:
  provider: openai_compatible
  endpoint: https://openrouter.ai/api/v1
  openRouter: true
  model: skill-model
  apiKey: sk-test
  providerIgnore:
    - together
  providerOrder:
    - anthropic
l3Llm:
  provider: openai_compatible
  endpoint: https://llm-proxy.example.com/v1
  openRouter: true
  model: l3-model
  apiKey: sk-test
  providerIgnore:
    - novita
  providerOrder:
    - openai
  reasoning:
    enabled: true
    maxTokens: 4000
`,
    });

    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "bootstrap-test",
    });

    expect(capturedLlmConfigs.find((cfg) => cfg.model === "skill-model")).toMatchObject({
      providerIgnore: ["together"],
      providerOrder: ["anthropic"],
      openRouter: true,
    });
    expect(capturedLlmConfigs.find((cfg) => cfg.model === "l3-model")).toMatchObject({
      providerIgnore: ["novita"],
      providerOrder: ["openai"],
      openRouter: true,
      reasoning: { enabled: true, maxTokens: 4_000 },
    });
  });

  it("normalizes missing dedicated OpenRouter flags to false", async () => {
    const { bootstrapMemoryCore } = await import("../../../core/pipeline/memory-core.js");
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: `
llm:
  provider: local_only
  model: main
skillEvolver:
  provider: openai_compatible
  model: skill-model
l3Llm:
  provider: openai_compatible
  model: l3-model
`,
    });
    const config = {
      ...home.config,
      skillEvolver: { ...home.config.skillEvolver, openRouter: undefined },
      l3Llm: { ...home.config.l3Llm, openRouter: undefined },
    } as unknown as typeof home.config;

    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config,
      pkgVersion: "bootstrap-test",
    });

    expect(capturedLlmConfigs.find((cfg) => cfg.model === "skill-model")?.openRouter).toBe(false);
    expect(capturedLlmConfigs.find((cfg) => cfg.model === "l3-model")?.openRouter).toBe(false);
  });
});
