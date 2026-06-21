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
  model: skill-model
  apiKey: sk-test
  providerIgnore:
    - together
  providerOrder:
    - anthropic
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
    });
  });
});
