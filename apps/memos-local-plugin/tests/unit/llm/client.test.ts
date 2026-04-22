import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MemosError } from "../../../agent-contract/errors.js";
import { ERROR_CODES } from "../../../agent-contract/errors.js";
import {
  __resetHostLlmBridgeForTests,
  createLlmClientWithProvider,
  registerHostLlmBridge,
} from "../../../core/llm/index.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type {
  LlmConfig,
  LlmMessage,
  LlmProvider,
  LlmProviderCtx,
  LlmProviderName,
  LlmStreamChunk,
  ProviderCallInput,
  ProviderCompletion,
} from "../../../core/llm/types.js";

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

class FakeProvider implements LlmProvider {
  public lastInput: ProviderCallInput | null = null;
  public lastMessages: LlmMessage[] | null = null;
  public invocations = 0;

  constructor(
    public readonly name: LlmProviderName,
    private readonly responder: (n: number) => ProviderCompletion,
  ) {}

  async complete(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    _ctx: LlmProviderCtx,
  ): Promise<ProviderCompletion> {
    this.invocations++;
    this.lastInput = opts;
    this.lastMessages = messages;
    return this.responder(this.invocations);
  }
}

class StreamingProvider implements LlmProvider {
  readonly name: LlmProviderName = "openai_compatible";
  async complete(): Promise<ProviderCompletion> {
    return { text: "full", durationMs: 1 };
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<LlmStreamChunk> {
    yield { delta: "he", done: false };
    yield { delta: "llo", done: false };
    yield {
      delta: "",
      done: true,
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    };
  }
}

class ThrowingProvider implements LlmProvider {
  readonly name: LlmProviderName = "openai_compatible";
  public calls = 0;
  constructor(private readonly error: unknown) {}
  async complete(): Promise<ProviderCompletion> {
    this.calls++;
    throw this.error;
  }
}

describe("llm/client", () => {
  beforeAll(() => initTestLogger());
  beforeEach(() => __resetHostLlmBridgeForTests());
  afterEach(() => __resetHostLlmBridgeForTests());

  it("normalizes string input into one user message", async () => {
    const fake = new FakeProvider("openai_compatible", () => ({ text: "ok", durationMs: 1 }));
    const client = createLlmClientWithProvider(cfg(), fake);
    await client.complete("hi there");
    expect(fake.lastMessages).toEqual([{ role: "user", content: "hi there" }]);
  });

  it("injects a json system hint when jsonMode=true", async () => {
    const fake = new FakeProvider("openai_compatible", () => ({ text: '{"ok":1}', durationMs: 1 }));
    const client = createLlmClientWithProvider(cfg(), fake);
    await client.complete("do it", { jsonMode: true });
    expect(fake.lastMessages?.[0]?.role).toBe("system");
    expect(fake.lastMessages?.[0]?.content).toMatch(/single valid JSON value/i);
    expect(fake.lastInput?.jsonMode).toBe(true);
  });

  it("completeJson parses + validates, increments no retries on success", async () => {
    const fake = new FakeProvider("openai_compatible", () => ({
      text: '{"alpha":0.6,"usable":true}',
      durationMs: 5,
    }));
    const client = createLlmClientWithProvider(cfg(), fake);
    const r = await client.completeJson<{ alpha: number; usable: boolean }>("score it", {
      schemaHint: `{ "alpha": number, "usable": boolean }`,
      validate: (v) => {
        const o = v as Record<string, unknown>;
        if (typeof o.alpha !== "number") throw new Error("bad alpha");
      },
    });
    expect(r.value.alpha).toBeCloseTo(0.6);
    expect(r.value.usable).toBe(true);
    expect(r.raw.length).toBeGreaterThan(0);
    expect(r.servedBy).toBe("openai_compatible");
    expect(client.stats().retries).toBe(0);
  });

  it("completeJson retries once on malformed output", async () => {
    const fake = new FakeProvider("openai_compatible", (n) => ({
      text: n === 1 ? "not json" : '{"x":1}',
      durationMs: 1,
    }));
    const client = createLlmClientWithProvider(cfg(), fake);
    const r = await client.completeJson<{ x: number }>("ask", { malformedRetries: 1 });
    expect(r.value.x).toBe(1);
    expect(client.stats().retries).toBe(1);
    expect(fake.invocations).toBe(2);
  });

  it("completeJson throws LLM_OUTPUT_MALFORMED when retries exhausted", async () => {
    const fake = new FakeProvider("openai_compatible", () => ({ text: "still bad", durationMs: 1 }));
    const client = createLlmClientWithProvider(cfg(), fake);
    try {
      await client.completeJson("ask", { malformedRetries: 1 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe(ERROR_CODES.LLM_OUTPUT_MALFORMED);
    }
    expect(fake.invocations).toBe(2);
  });

  it("stream passes provider-native chunks through", async () => {
    const client = createLlmClientWithProvider(cfg(), new StreamingProvider());
    const chunks: LlmStreamChunk[] = [];
    for await (const c of client.stream("tell me something")) chunks.push(c);
    expect(chunks.map((c) => c.delta).join("")).toBe("hello");
    expect(chunks[chunks.length - 1]?.done).toBe(true);
    expect(chunks[chunks.length - 1]?.usage?.totalTokens).toBe(3);
  });

  it("stream falls back to one-shot emit when provider has no stream()", async () => {
    const fake = new FakeProvider("openai_compatible", () => ({ text: "whole", durationMs: 1 }));
    const client = createLlmClientWithProvider(cfg(), fake);
    const parts: string[] = [];
    for await (const c of client.stream("x")) {
      if (!c.done) parts.push(c.delta);
    }
    expect(parts.join("")).toBe("whole");
  });

  it("stats() reports tokens from successful calls", async () => {
    const fake = new FakeProvider("openai_compatible", () => ({
      text: "hi",
      durationMs: 1,
      usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
    }));
    const client = createLlmClientWithProvider(cfg(), fake);
    await client.complete("x");
    await client.complete("y");
    const s = client.stats();
    expect(s.totalPromptTokens).toBe(8);
    expect(s.totalCompletionTokens).toBe(12);
    expect(s.requests).toBe(2);
    client.resetStats();
    expect(client.stats().totalPromptTokens).toBe(0);
  });

  it("throws MemosError through when primary fails and fallbackToHost=false", async () => {
    const thrower = new ThrowingProvider(
      new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "nope"),
    );
    const client = createLlmClientWithProvider(cfg({ fallbackToHost: false }), thrower);
    try {
      await client.complete("x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe("llm_unavailable");
    }
    expect(client.stats().failures).toBe(1);
  });

  it("falls back to host when registered and primary reports LLM_UNAVAILABLE", async () => {
    const thrower = new ThrowingProvider(
      new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "transient"),
    );
    registerHostLlmBridge({
      id: "test.host.v1",
      async complete({ messages }) {
        return {
          text: `host:${messages[messages.length - 1]?.content ?? ""}`,
          model: "host-m",
          durationMs: 1,
          usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
        };
      },
    });
    const client = createLlmClientWithProvider(cfg({ fallbackToHost: true }), thrower);
    const r = await client.complete("ping");
    expect(r.text).toBe("host:ping");
    expect(r.servedBy).toBe("host_fallback");
    expect(client.stats().hostFallbacks).toBe(1);
  });

  it("does NOT fall back when primary throws a non-transient error", async () => {
    const thrower = new ThrowingProvider(
      new MemosError(ERROR_CODES.INVALID_ARGUMENT, "bad payload"),
    );
    registerHostLlmBridge({
      id: "test.host.v1",
      async complete() {
        throw new Error("host should not be called");
      },
    });
    const client = createLlmClientWithProvider(cfg({ fallbackToHost: true }), thrower);
    try {
      await client.complete("x");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as MemosError).code).toBe(ERROR_CODES.INVALID_ARGUMENT);
    }
    expect(client.stats().hostFallbacks).toBe(0);
  });

  it("does NOT fall back when no host bridge is registered", async () => {
    const thrower = new ThrowingProvider(
      new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "nope"),
    );
    const client = createLlmClientWithProvider(cfg({ fallbackToHost: true }), thrower);
    try {
      await client.complete("x");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as MemosError).code).toBe(ERROR_CODES.LLM_UNAVAILABLE);
    }
    expect(client.stats().hostFallbacks).toBe(0);
  });

  it("preserves existing system message when injecting JSON hint", async () => {
    const fake = new FakeProvider("openai_compatible", () => ({ text: '{"n":1}', durationMs: 1 }));
    const client = createLlmClientWithProvider(cfg(), fake);
    await client.completeJson(
      [
        { role: "system", content: "You are strict." },
        { role: "user", content: "go" },
      ],
      {},
    );
    expect(fake.lastMessages?.[0]?.role).toBe("system");
    expect(fake.lastMessages?.[0]?.content).toMatch(/You are strict\./);
    expect(fake.lastMessages?.[0]?.content).toMatch(/single valid JSON value/);
    expect(fake.lastMessages?.[1]).toEqual({ role: "user", content: "go" });
  });

  it("rejects empty messages array", async () => {
    const fake = new FakeProvider("openai_compatible", () => ({ text: "", durationMs: 1 }));
    const client = createLlmClientWithProvider(cfg(), fake);
    await expect(client.complete([] as LlmMessage[])).rejects.toBeInstanceOf(MemosError);
  });
});
