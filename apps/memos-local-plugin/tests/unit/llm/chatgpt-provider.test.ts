/**
 * `chatgpt` provider (Sign in with ChatGPT, Responses API).
 *
 * Mocked fetch + mocked SSE streams only: no network, no real tokens.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { beforeEach, describe, expect, it } from "vitest";

import { resolveConfig } from "../../../core/config/index.js";
import { ConfigSchema } from "../../../core/config/schema.js";
import { createLlmClientWithProvider, makeProviderFor } from "../../../core/llm/client.js";
import {
  ChatGptLlmProvider,
  PAUSE_MS,
  resetChatGptPauseState,
} from "../../../core/llm/providers/chatgpt.js";
import { ChatGptAuthError, type AccessToken, type TokenOptions } from "../../../core/llm/chatgpt-auth.js";
import type {
  ChatGptProviderConfig,
  LlmConfig,
  LlmMessage,
  LlmProvider,
  LlmProviderCtx,
  LlmProviderLogger,
  LlmStreamChunk,
  ProviderCallInput,
} from "../../../core/llm/types.js";

const noopLog: LlmProviderLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

type SseEvent = { type: string } & Record<string, unknown>;

function sse(events: SseEvent[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}
function streamResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/event-stream" } });
}
function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function okEvents(
  parts: string[],
  usage = { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
): SseEvent[] {
  return [
    { type: "response.created", response: { status: "in_progress" } },
    ...parts.map((delta) => ({ type: "response.output_text.delta", delta })),
    { type: "response.completed", response: { status: "completed", usage } },
  ];
}

function makeFallback() {
  const calls = { complete: 0, stream: 0 };
  const provider: LlmProvider = {
    name: "openai_compatible",
    async complete() {
      calls.complete++;
      return { text: "from-fallback", finishReason: "stop", durationMs: 1 };
    },
    async *stream() {
      calls.stream++;
      yield { delta: "from-fallback", done: false };
      yield { delta: "", done: true };
    },
  };
  return { calls, provider };
}

function baseConfig(chatgpt: ChatGptProviderConfig): LlmConfig {
  return {
    provider: "chatgpt",
    model: "openai/fallback-model",
    temperature: 0,
    fallbackToHost: false,
    timeoutMs: 5_000,
    maxRetries: 0,
    openRouter: true,
    endpoint: "https://openrouter.ai/api/v1",
    apiKey: "sk-fallback-test",
    chatgpt,
  };
}

type QueuedResponse = Response | (() => Response);

function setup({
  responses,
  chatgpt = {},
  token = "tok-A",
}: { responses: QueuedResponse[]; chatgpt?: ChatGptProviderConfig; token?: string }) {
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const tokenCalls: TokenOptions[] = [];
  let clock = 1_000_000;
  const queue = [...responses];
  const fb = makeFallback();
  const provider = new ChatGptLlmProvider({
    fetchImpl: (async (url: string, init: RequestInit) => {
      requests.push({ url, init, body: JSON.parse(String(init.body)) });
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra fetch");
      return typeof next === "function" ? next() : next;
    }) as unknown as typeof fetch,
    getToken: async (o: TokenOptions): Promise<AccessToken> => {
      tokenCalls.push(o);
      return { accessToken: o.force ? "tok-B" : token, expiresAt: clock + 3_600_000 };
    },
    now: () => clock,
    sleep: async () => {},
    fallback: fb.provider,
  });
  const ctx = { config: baseConfig(chatgpt), log: noopLog } as LlmProviderCtx;
  return {
    provider,
    ctx,
    requests,
    tokenCalls,
    fb,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const call: ProviderCallInput = { temperature: 0, maxTokens: 512, jsonMode: false };
const msgs: LlmMessage[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "hello" },
];
const headers = (init: RequestInit) => init.headers as Record<string, string>;

async function collect(it: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("ChatGptLlmProvider", () => {
  beforeEach(() => resetChatGptPauseState());

  it("streams deltas, completes only on response.completed, and sends the required body", async () => {
    const s = setup({ responses: [streamResponse(sse(okEvents(["Hel", "lo"])))], chatgpt: { model: "m-test" } });
    const out = await s.provider.complete(msgs, call, s.ctx);
    expect(out.text).toBe("Hello");
    expect(out.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    const r = s.requests[0]!;
    expect(r.url).toBe("https://api.openai.com/v1/responses");
    expect(headers(r.init).Authorization).toBe("Bearer tok-A");
    expect(r.body.store).toBe(false);
    expect(r.body.stream).toBe(true);
    expect(r.body.model).toBe("m-test");
    expect(r.body.instructions).toBe("SYS");
    expect(r.body.input).toEqual([{ role: "user", content: "hello" }]);
    for (const banned of ["temperature", "max_output_tokens", "text"]) expect(r.body).not.toHaveProperty(banned);
    expect(s.fb.calls.complete).toBe(0);
  });

  it("falls back and pauses ChatGPT when the usage limit arrives mid-stream as response.failed", async () => {
    const failed: SseEvent[] = [
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.failed",
        response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded" } },
      },
    ];
    const s = setup({ responses: [streamResponse(sse(failed))] });
    expect((await s.provider.complete(msgs, call, s.ctx)).text).toBe("from-fallback");
    expect(s.fb.calls.complete).toBe(1);
    // Inside the pause window: straight to the fallback, no ChatGPT fetch.
    expect((await s.provider.complete(msgs, call, s.ctx)).text).toBe("from-fallback");
    expect(s.requests).toHaveLength(1);
    // After the pause ChatGPT is tried again (empty queue → fetch throws → retries → fallback).
    s.advance(PAUSE_MS.usageLimit + 1);
    expect((await s.provider.complete(msgs, call, s.ctx)).text).toBe("from-fallback");
    expect(s.requests.length).toBeGreaterThan(1);
  });

  it("throws llm_rate_limited for an HTTP 429 usage limit when fallback is disabled", async () => {
    const s = setup({
      responses: [jsonResponse({ error: { code: "subscription_sharing_usage_limit_exceeded" } }, 429)],
      chatgpt: { fallback: false },
    });
    await expect(s.provider.complete(msgs, call, s.ctx)).rejects.toMatchObject({
      code: "llm_rate_limited",
      message: expect.stringMatching(/usage_limit/),
    });
    expect(s.fb.calls.complete).toBe(0);
  });

  it("treats a stream that ends without response.completed as a failure", async () => {
    const s = setup({ responses: [streamResponse(sse([{ type: "response.output_text.delta", delta: "cut" }]))] });
    expect((await s.provider.complete(msgs, call, s.ctx)).text).toBe("from-fallback");
  });

  it("treats response.incomplete as a failure", async () => {
    const s = setup({
      responses: [
        streamResponse(
          sse([{ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }]),
        ),
      ],
    });
    expect((await s.provider.complete(msgs, call, s.ctx)).text).toBe("from-fallback");
  });

  it("refreshes once after a 401 and retries with the new token", async () => {
    const s = setup({
      responses: [jsonResponse({ error: { code: "invalid_token" } }, 401), streamResponse(sse(okEvents(["ok"])))],
    });
    expect((await s.provider.complete(msgs, call, s.ctx)).text).toBe("ok");
    expect(s.tokenCalls).toHaveLength(2);
    expect(s.tokenCalls[1]).toMatchObject({ force: true, staleAccessToken: "tok-A" });
    expect(headers(s.requests[1]!.init).Authorization).toBe("Bearer tok-B");
  });

  it("retries a 503 with bounded backoff, then falls back", async () => {
    const busy = () => jsonResponse({ error: { code: "subscription_sharing_usage_unavailable" } }, 503);
    const s = setup({ responses: [busy, busy, busy] });
    expect((await s.provider.complete(msgs, call, s.ctx)).text).toBe("from-fallback");
    expect(s.requests).toHaveLength(3);
  });

  it("asks for json_object in JSON mode and drops text.format once if the route rejects it", async () => {
    const s = setup({
      responses: [
        jsonResponse({ error: { code: "subscription_sharing_unsupported_capability", param: "text.format" } }, 400),
        streamResponse(sse(okEvents(['{"a":', "1}"]))),
      ],
    });
    const out = await s.provider.complete(msgs, { ...call, jsonMode: true }, s.ctx);
    expect(out.text).toBe('{"a":1}');
    expect(s.requests[0]!.body.text).toEqual({ format: { type: "json_object" } });
    expect(s.requests[1]!.body).not.toHaveProperty("text");
  });

  it("works through the real LlmClient facade (completeJson)", async () => {
    const s = setup({ responses: [streamResponse(sse(okEvents(['{"score":', " 0.5}"])))] });
    const client = createLlmClientWithProvider(s.ctx.config, s.provider);
    const res = await client.completeJson<{ score: number }>([{ role: "user", content: "rate this" }], {
      op: "test.json",
    });
    expect(res.value).toEqual({ score: 0.5 });
    expect(res.servedBy).toBe("chatgpt");
    // The facade's JSON hint must arrive as instructions, not as a system input item.
    const body = s.requests[0]!.body as { instructions: string; input: Array<{ role: string }> };
    expect(body.instructions.length).toBeGreaterThan(0);
    expect(body.input.every((i) => i.role !== "system")).toBe(true);
  });

  it("stream() yields ChatGPT deltas, and falls back when nothing was emitted yet", async () => {
    const ok = setup({ responses: [streamResponse(sse(okEvents(["a", "b"])))] });
    const got = await collect(ok.provider.stream(msgs, call, ok.ctx));
    expect(got.filter((c) => !c.done).map((c) => c.delta).join("")).toBe("ab");
    expect(got.at(-1)?.done).toBe(true);

    const bad = setup({
      responses: [jsonResponse({ error: { code: "subscription_sharing_user_not_eligible" } }, 403)],
    });
    const got2 = await collect(bad.provider.stream(msgs, call, bad.ctx));
    expect(got2[0]?.delta).toBe("from-fallback");
    expect(bad.fb.calls.stream).toBe(1);
  });

  it("falls back when no token file exists (not signed in)", async () => {
    const fb = makeFallback();
    const p = new ChatGptLlmProvider({
      fallback: fb.provider,
      fetchImpl: (async () => {
        throw new Error("no fetch expected");
      }) as unknown as typeof fetch,
    });
    const ctx = {
      config: {
        ...baseConfig({ tokenFile: join(tmpdir(), "memos-chatgpt-does-not-exist.json") }),
        openRouter: false,
      },
      log: noopLog,
    } as LlmProviderCtx;
    expect((await p.complete(msgs, call, ctx)).text).toBe("from-fallback");
    expect(fb.calls.complete).toBe(1);
  });

  it("does not pause after not_signed_in, so a sign-in takes effect on the next call", async () => {
    const fb = makeFallback();
    let signedIn = false;
    const requests: string[] = [];
    const p = new ChatGptLlmProvider({
      fallback: fb.provider,
      getToken: async () => {
        if (!signedIn) throw new ChatGptAuthError("not_signed_in", "not signed in");
        return { accessToken: "tok-A", expiresAt: Date.now() + 3_600_000 };
      },
      fetchImpl: (async (url: string) => {
        requests.push(url);
        return streamResponse(sse(okEvents(["ok"])));
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    const ctx = { config: baseConfig({}), log: noopLog } as LlmProviderCtx;
    expect((await p.complete(msgs, call, ctx)).text).toBe("from-fallback");
    signedIn = true;
    expect((await p.complete(msgs, call, ctx)).text).toBe("ok");
    expect(requests).toHaveLength(1);
  });

  it("reports the ChatGPT error instead of falling back when the block has no fallback target", async () => {
    const fb = makeFallback();
    const p = new ChatGptLlmProvider({
      fallback: fb.provider,
      getToken: async () => {
        throw new ChatGptAuthError("not_signed_in", "not signed in");
      },
    });
    const ctx = {
      config: { ...baseConfig({}), endpoint: "", apiKey: "" },
      log: noopLog,
    } as LlmProviderCtx;
    await expect(p.complete(msgs, call, ctx)).rejects.toMatchObject({
      code: "llm_unavailable",
      message: expect.stringMatching(/auth:not_signed_in/),
    });
    await expect(collect(p.stream(msgs, call, ctx))).rejects.toMatchObject({ code: "llm_unavailable" });
    expect(fb.calls).toEqual({ complete: 0, stream: 0 });
  });

  it("stream(): a failure after the first delta is thrown, and still pauses ChatGPT", async () => {
    const failed: SseEvent[] = [
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.failed",
        response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded" } },
      },
    ];
    const s = setup({ responses: [streamResponse(sse(failed))] });
    await expect(collect(s.provider.stream(msgs, call, s.ctx))).rejects.toMatchObject({ code: "llm_rate_limited" });
    expect(s.fb.calls.stream).toBe(0);
    // Paused: the next call goes straight to the fallback without a ChatGPT request.
    const next = await collect(s.provider.stream(msgs, call, s.ctx));
    expect(next[0]?.delta).toBe("from-fallback");
    expect(s.requests).toHaveLength(1);
  });

  it("surfaces unexpected local errors instead of re-sending the prompt to the fallback", async () => {
    const fb = makeFallback();
    const p = new ChatGptLlmProvider({
      fallback: fb.provider,
      getToken: async () => {
        throw new TypeError("bug in local code");
      },
    });
    const ctx = { config: baseConfig({}), log: noopLog } as LlmProviderCtx;
    await expect(p.complete(msgs, call, ctx)).rejects.toMatchObject({ code: "llm_unavailable" });
    expect(fb.calls.complete).toBe(0);
  });

  it("treats a connection dropped while reading the stream as a ChatGPT failure (falls back)", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse([{ type: "response.output_text.delta", delta: "x" }])));
        controller.error(new TypeError("terminated"));
      },
    });
    const s = setup({ responses: [new Response(broken, { status: 200 })] });
    expect((await s.provider.complete(msgs, call, s.ctx)).text).toBe("from-fallback");
  });

  it("still pauses after the server rejects the sign-in (HTTP 403)", async () => {
    const s = setup({ responses: [jsonResponse({ error: { code: "forbidden" } }, 403)] });
    expect((await s.provider.complete(msgs, call, s.ctx)).text).toBe("from-fallback");
    expect((await s.provider.complete(msgs, call, s.ctx)).text).toBe("from-fallback");
    expect(s.requests).toHaveLength(1);
  });
});

describe("chatgpt provider registration", () => {
  it("makeProviderFor('chatgpt') returns the new provider; existing names are unchanged", () => {
    expect(makeProviderFor("chatgpt").name).toBe("chatgpt");
    expect(makeProviderFor("openai_compatible").name).toBe("openai_compatible");
  });

  it("config schema accepts llm.provider chatgpt with an llm.chatgpt block", () => {
    const cfg = Value.Default(ConfigSchema, {
      llm: {
        provider: "chatgpt",
        endpoint: "https://openrouter.ai/api/v1",
        model: "x",
        chatgpt: { model: "m", fallback: true },
      },
    });
    expect([...Value.Errors(ConfigSchema, cfg)].map((e) => `${e.path}: ${e.message}`)).toEqual([]);
  });

  it("config schema accepts skillEvolver.provider chatgpt; unknown providers still fail", () => {
    const ok = Value.Default(ConfigSchema, {
      skillEvolver: { provider: "chatgpt", model: "openai/x", chatgpt: { model: "x", fallback: true } },
    });
    expect([...Value.Errors(ConfigSchema, ok)].map((e) => `${e.path}: ${e.message}`)).toEqual([]);
    const bad = Value.Default(ConfigSchema, { skillEvolver: { provider: "not_a_provider", model: "x" } });
    expect([...Value.Errors(ConfigSchema, bad)].some((e) => e.path.startsWith("/skillEvolver/provider"))).toBe(true);
  });

  it("loading a chatgpt block raises no 'unknown config key' warning", () => {
    const warnings: string[] = [];
    resolveConfig(
      {
        llm: { provider: "chatgpt", chatgpt: { model: "m", fallback: true, tokenFile: "/tmp/t.json" } },
        skillEvolver: { provider: "chatgpt", model: "x", chatgpt: { model: "m" } },
        l3Llm: { provider: "chatgpt", model: "x", chatgpt: { fallback: false } },
      },
      warnings,
    );
    expect(warnings.filter((w) => w.includes("chatgpt"))).toEqual([]);
  });

  it("config schema rejects an unknown chatgpt.reasoningEffort", () => {
    const ok = Value.Default(ConfigSchema, { llm: { provider: "chatgpt", chatgpt: { reasoningEffort: "low" } } });
    expect([...Value.Errors(ConfigSchema, ok)]).toEqual([]);
    const bad = Value.Default(ConfigSchema, { llm: { provider: "chatgpt", chatgpt: { reasoningEffort: "loww" } } });
    expect([...Value.Errors(ConfigSchema, bad)].some((e) => e.path.startsWith("/llm/chatgpt/reasoningEffort"))).toBe(true);
  });
});
