/**
 * Truncation retry budget: finish_reason="length" is a budget problem, not
 * plain malformed output. The retry must double max_tokens (once, capped)
 * instead of re-sending the same doomed budget.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { MemosError } from "../../../agent-contract/errors.js";
import { createLlmClientWithProvider } from "../../../core/llm/index.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type {
  LlmConfig,
  LlmMessage,
  LlmProvider,
  LlmProviderCtx,
  LlmProviderName,
  ProviderCallInput,
  ProviderCompletion,
} from "../../../core/llm/types.js";

beforeAll(async () => {
  await initTestLogger();
});

function cfg(partial: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai_compatible",
    model: "gpt-test",
    endpoint: "",
    apiKey: "X",
    temperature: 0.3,
    fallbackToHost: false,
    timeoutMs: 5_000,
    maxRetries: 0,
    ...partial,
  };
}

class StubProvider implements LlmProvider {
  public inputs: ProviderCallInput[] = [];
  public readonly name: LlmProviderName;
  constructor(
    name: LlmProviderName,
    private readonly responder: (n: number) => ProviderCompletion,
  ) {
    this.name = name;
  }
  async complete(
    _messages: LlmMessage[],
    opts: ProviderCallInput,
    _ctx: LlmProviderCtx,
  ): Promise<ProviderCompletion> {
    this.inputs.push(opts);
    return this.responder(this.inputs.length);
  }
}

const DEFAULT_MAX_TOKENS = 1024;

describe("completeJson truncation retry budget", () => {
  it("doubles max_tokens after finish_reason=length and parses the retry", async () => {
    const stub = new StubProvider("openai_compatible", (n) =>
      n === 1
        ? { text: "{\"x\":", durationMs: 1, finishReason: "length" as const }
        : { text: "{\"x\":1}", durationMs: 1, finishReason: "stop" as const },
    );
    const client = createLlmClientWithProvider(cfg(), stub);
    const r = await client.completeJson<{ x: number }>("ask", { malformedRetries: 1 });
    expect(r.value.x).toBe(1);
    expect(stub.inputs).toHaveLength(2);
    expect(stub.inputs[0]!.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(stub.inputs[1]!.maxTokens).toBe(2 * DEFAULT_MAX_TOKENS);
  });

  it("still retries once on truncation when malformedRetries is 0", async () => {
    const stub = new StubProvider("openai_compatible", (n) =>
      n === 1
        ? { text: "{\"q\":", durationMs: 1, finishReason: "length" as const }
        : { text: "{\"q\":2}", durationMs: 1, finishReason: "stop" as const },
    );
    const client = createLlmClientWithProvider(cfg(), stub);
    const r = await client.completeJson<{ q: number }>("ask", { malformedRetries: 0 });
    expect(r.value.q).toBe(2);
    expect(stub.inputs).toHaveLength(2);
    expect(stub.inputs[1]!.maxTokens).toBe(2 * DEFAULT_MAX_TOKENS);
  });

  it("caps the doubled budget at 32768", async () => {
    const stub = new StubProvider("openai_compatible", (n) =>
      n === 1
        ? { text: "truncated", durationMs: 1, finishReason: "length" as const }
        : { text: "{\"y\":2}", durationMs: 1, finishReason: "stop" as const },
    );
    const client = createLlmClientWithProvider(cfg({ maxTokens: 16_384 }), stub);
    const r = await client.completeJson<{ y: number }>("ask", { malformedRetries: 1 });
    expect(r.value.y).toBe(2);
    expect(stub.inputs[0]!.maxTokens).toBe(16_384);
    expect(stub.inputs[1]!.maxTokens).toBe(32_768);
  });

  it("doubles at most once across consecutive truncations", async () => {
    const stub = new StubProvider("openai_compatible", () => ({
      text: "truncated",
      durationMs: 1,
      finishReason: "length" as const,
    }));
    const client = createLlmClientWithProvider(cfg({ maxTokens: 16_384 }), stub);
    await expect(
      client.completeJson("ask", { malformedRetries: 2 }),
    ).rejects.toBeInstanceOf(MemosError);
    expect(stub.inputs).toHaveLength(3);
    expect(stub.inputs[0]!.maxTokens).toBe(16_384);
    expect(stub.inputs[1]!.maxTokens).toBe(32_768);
    expect(stub.inputs[2]!.maxTokens).toBe(32_768); // no further doubling
  });

  it("keeps the budget unchanged when finish_reason is stop", async () => {
    const stub = new StubProvider("openai_compatible", (n) =>
      n === 1
        ? { text: "not json", durationMs: 1, finishReason: "stop" as const }
        : { text: "{\"z\":3}", durationMs: 1, finishReason: "stop" as const },
    );
    const client = createLlmClientWithProvider(cfg(), stub);
    const r = await client.completeJson<{ z: number }>("ask", { malformedRetries: 1 });
    expect(r.value.z).toBe(3);
    expect(stub.inputs[1]!.maxTokens).toBe(stub.inputs[0]!.maxTokens);
  });
});
