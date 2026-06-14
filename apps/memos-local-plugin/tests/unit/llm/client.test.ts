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
  LlmStatusDetail,
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

  // ─── Circuit breaker (issue #1897) ──────────────────────────────────────
  describe("circuit breaker", () => {
    function statusSink(): { rows: LlmStatusDetail[]; push: (d: LlmStatusDetail) => void } {
      const rows: LlmStatusDetail[] = [];
      return { rows, push: (d) => rows.push(d) };
    }

    it("trips on terminal 402 and short-circuits subsequent calls", async () => {
      const sink = statusSink();
      let now = 1_000_000;
      const tick = () => now;
      const provider = new ThrowingProvider(
        new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "HTTP 402 from openai_compatible", {
          provider: "openai_compatible",
          status: 402,
        }),
      );
      const client = createLlmClientWithProvider(
        cfg({
          onStatus: sink.push,
          circuitBreaker: { enabled: true, cooldownMs: 300_000, now: tick },
        }),
        provider,
      );
      // First call: real provider hit, fails terminally → breaker trips.
      await expect(client.complete("first")).rejects.toBeInstanceOf(MemosError);
      expect(provider.calls).toBe(1);
      // Second call: should be short-circuited; provider must NOT be invoked.
      now += 100;
      await expect(client.complete("second")).rejects.toMatchObject({
        code: ERROR_CODES.LLM_UNAVAILABLE,
        details: { circuitOpen: true },
      });
      expect(provider.calls).toBe(1);
      // Stats expose circuit state.
      const stats = client.stats();
      expect(stats.circuitOpen).toBe(true);
      expect(stats.circuitOpenUntil).toBe(1_000_000 + 300_000);
      expect(stats.circuitOpenedReason).toMatch(/402/);
      // Audit rows: at least one `error` and one `circuit_open`.
      const statuses = sink.rows.map((r) => r.status);
      expect(statuses).toContain("error");
      expect(statuses).toContain("circuit_open");
    });

    it("trips on 'insufficient balance' message regardless of HTTP status", async () => {
      const sink = statusSink();
      const provider = new ThrowingProvider(
        new MemosError(
          ERROR_CODES.LLM_UNAVAILABLE,
          "HTTP 400 from openai_compatible: Insufficient Balance",
          { provider: "openai_compatible", status: 400 },
        ),
      );
      const client = createLlmClientWithProvider(
        cfg({ onStatus: sink.push, circuitBreaker: { enabled: true } }),
        provider,
      );
      await expect(client.complete("x")).rejects.toBeInstanceOf(MemosError);
      await expect(client.complete("y")).rejects.toMatchObject({
        details: { circuitOpen: true },
      });
      expect(provider.calls).toBe(1);
    });

    it("does NOT trip on generic LLM_UNAVAILABLE without terminal markers", async () => {
      const sink = statusSink();
      const provider = new ThrowingProvider(
        new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "transient network blip"),
      );
      const client = createLlmClientWithProvider(
        cfg({ onStatus: sink.push, circuitBreaker: { enabled: true } }),
        provider,
      );
      // Two consecutive failures with non-terminal classification → both
      // calls reach the provider, breaker stays closed.
      await expect(client.complete("x")).rejects.toBeInstanceOf(MemosError);
      await expect(client.complete("y")).rejects.toBeInstanceOf(MemosError);
      expect(provider.calls).toBe(2);
      expect(client.stats().circuitOpen).toBe(false);
    });

    it("coalesces circuit_open status rows within cooldown", async () => {
      const sink = statusSink();
      let now = 1_000_000;
      const tick = () => now;
      const provider = new ThrowingProvider(
        new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "401", { status: 401 }),
      );
      const client = createLlmClientWithProvider(
        cfg({
          onStatus: sink.push,
          circuitBreaker: { enabled: true, cooldownMs: 300_000, now: tick },
        }),
        provider,
      );
      await expect(client.complete("trip")).rejects.toBeTruthy();
      // 20 suppressed calls within 1 second → at most a small number of
      // `circuit_open` rows (we expect 1, but tolerate up to 2 in case the
      // coalescer counts the very first short-circuit as a separate row).
      for (let i = 0; i < 20; i++) {
        now += 50;
        await expect(client.complete(`spam-${i}`)).rejects.toBeTruthy();
      }
      const openRows = sink.rows.filter((r) => r.status === "circuit_open");
      expect(openRows.length).toBeGreaterThanOrEqual(1);
      expect(openRows.length).toBeLessThanOrEqual(2);
      // Provider was only touched once (the very first call that tripped).
      expect(provider.calls).toBe(1);
    });

    it("half-open probes the provider after cooldown and closes on success", async () => {
      const sink = statusSink();
      let now = 1_000_000;
      const tick = () => now;
      let attempt = 0;
      const provider: LlmProvider = {
        name: "openai_compatible",
        async complete() {
          attempt++;
          if (attempt === 1) {
            throw new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "401", { status: 401 });
          }
          return { text: "ok", durationMs: 1 };
        },
      };
      const client = createLlmClientWithProvider(
        cfg({
          onStatus: sink.push,
          circuitBreaker: { enabled: true, cooldownMs: 60_000, now: tick },
        }),
        provider,
      );
      await expect(client.complete("trip")).rejects.toBeTruthy();
      expect(client.stats().circuitOpen).toBe(true);
      // Suppressed call before cooldown elapses.
      now += 30_000;
      await expect(client.complete("suppressed")).rejects.toMatchObject({
        details: { circuitOpen: true },
      });
      expect(attempt).toBe(1);
      // After cooldown, the next call probes the provider.
      now += 31_000; // total 61_000 since trip
      const r = await client.complete("probe");
      expect(r.text).toBe("ok");
      expect(attempt).toBe(2);
      // Breaker closes on success.
      expect(client.stats().circuitOpen).toBe(false);
    });

    it("does NOT trip when host fallback rescues the call", async () => {
      const sink = statusSink();
      const provider = new ThrowingProvider(
        new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "402", { status: 402 }),
      );
      registerHostLlmBridge({
        id: "test.host",
        async complete() {
          return { text: "rescued", model: "host-m", durationMs: 1 };
        },
      });
      const client = createLlmClientWithProvider(
        cfg({
          fallbackToHost: true,
          onStatus: sink.push,
          circuitBreaker: { enabled: true },
        }),
        provider,
      );
      const r = await client.complete("call-1");
      expect(r.servedBy).toBe("host_fallback");
      // Breaker still closed: fallback rescued the call.
      expect(client.stats().circuitOpen).toBe(false);
      const r2 = await client.complete("call-2");
      expect(r2.servedBy).toBe("host_fallback");
      // Provider hit twice; not short-circuited.
      expect(provider.calls).toBe(2);
    });

    it("disabled when circuitBreaker.enabled=false (legacy behavior)", async () => {
      const provider = new ThrowingProvider(
        new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "402", { status: 402 }),
      );
      const client = createLlmClientWithProvider(
        cfg({ circuitBreaker: { enabled: false } }),
        provider,
      );
      await expect(client.complete("a")).rejects.toBeTruthy();
      await expect(client.complete("b")).rejects.toBeTruthy();
      await expect(client.complete("c")).rejects.toBeTruthy();
      // All three calls reached the provider.
      expect(provider.calls).toBe(3);
      expect(client.stats().circuitOpen).toBe(false);
    });

    it("LlmClientStats exposes circuit fields when closed", async () => {
      const fake = new FakeProvider("openai_compatible", () => ({ text: "ok", durationMs: 1 }));
      const client = createLlmClientWithProvider(cfg(), fake);
      await client.complete("x");
      const s = client.stats();
      expect(s.circuitOpen).toBe(false);
      expect(s.circuitOpenUntil).toBeNull();
      expect(s.circuitOpenedReason).toBeNull();
    });

    it("re-opens the breaker if the half-open probe fails terminally again", async () => {
      const sink = statusSink();
      let now = 1_000_000;
      const tick = () => now;
      const provider = new ThrowingProvider(
        new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "402", { status: 402 }),
      );
      const client = createLlmClientWithProvider(
        cfg({
          onStatus: sink.push,
          circuitBreaker: { enabled: true, cooldownMs: 60_000, now: tick },
        }),
        provider,
      );
      await expect(client.complete("trip")).rejects.toBeTruthy();
      expect(client.stats().circuitOpen).toBe(true);
      now += 61_000;
      // Half-open probe still fails terminally → breaker re-opens.
      await expect(client.complete("probe")).rejects.toBeTruthy();
      expect(client.stats().circuitOpen).toBe(true);
      expect(client.stats().circuitOpenUntil).toBe(now + 60_000);
      // Provider was touched twice total (initial trip + probe).
      expect(provider.calls).toBe(2);
    });
  });
});
