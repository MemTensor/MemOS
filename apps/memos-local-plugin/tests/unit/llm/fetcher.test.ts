import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MemosError } from "../../../agent-contract/errors.js";
import { decodeSse, httpPostJson, httpPostStream } from "../../../core/llm/fetcher.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type { LlmProviderLogger } from "../../../core/llm/types.js";

function nullLog(): LlmProviderLogger {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function mockFetch(replies: Array<Response | Error>) {
  let i = 0;
  const f = vi.fn(async () => {
    const r = replies[i++];
    if (!r) throw new Error("mockFetch exhausted");
    if (r instanceof Error) throw r;
    return r;
  });
  vi.stubGlobal("fetch", f);
  return f;
}

describe("llm/fetcher", () => {
  beforeAll(() => initTestLogger());
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed JSON on 200", async () => {
    mockFetch([new Response(JSON.stringify({ a: 1 }), { status: 200 })]);
    const { json, durationMs } = await httpPostJson<{ a: number }>({
      url: "https://x",
      body: {},
      timeoutMs: 5_000,
      maxRetries: 0,
      provider: "openai_compatible",
      log: nullLog(),
    });
    expect(json.a).toBe(1);
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it("retries on 500 and succeeds", async () => {
    const f = mockFetch([
      new Response("ouch", { status: 500 }),
      new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    ]);
    await httpPostJson({
      url: "https://x",
      body: {},
      timeoutMs: 5_000,
      maxRetries: 2,
      provider: "anthropic",
      log: nullLog(),
    });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("rate-limit 429 after retries → LLM_RATE_LIMITED", async () => {
    mockFetch([
      new Response("slow down", { status: 429 }),
      new Response("slow down", { status: 429 }),
    ]);
    try {
      await httpPostJson({
        url: "https://x",
        body: {},
        timeoutMs: 5_000,
        maxRetries: 1,
        provider: "openai_compatible",
        log: nullLog(),
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe("llm_rate_limited");
    }
  });

  it("4xx (non-429) does not retry → LLM_UNAVAILABLE", async () => {
    const f = mockFetch([new Response("bad", { status: 400 })]);
    try {
      await httpPostJson({
        url: "https://x",
        body: {},
        timeoutMs: 5_000,
        maxRetries: 3,
        provider: "openai_compatible",
        log: nullLog(),
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe("llm_unavailable");
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("timeout → LLM_TIMEOUT", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    mockFetch([timeout]);
    try {
      await httpPostJson({
        url: "https://x",
        body: {},
        timeoutMs: 5,
        maxRetries: 0,
        provider: "anthropic",
        log: nullLog(),
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe("llm_timeout");
    }
  });

  it("network error → LLM_UNAVAILABLE", async () => {
    mockFetch([new Error("ECONNRESET")]);
    try {
      await httpPostJson({
        url: "https://x",
        body: {},
        timeoutMs: 5_000,
        maxRetries: 0,
        provider: "gemini",
        log: nullLog(),
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe("llm_unavailable");
    }
  });

  it("httpPostStream returns a ReadableStream body on 200", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("data: {}\n\n"));
        ctrl.close();
      },
    });
    mockFetch([new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })]);
    const resp = await httpPostStream({
      url: "https://x",
      body: {},
      timeoutMs: 5_000,
      provider: "openai_compatible",
      log: nullLog(),
    });
    expect(resp.body).toBeTruthy();
  });

  it("httpPostStream maps non-ok to MemosError", async () => {
    mockFetch([new Response("nope", { status: 500 })]);
    try {
      await httpPostStream({
        url: "https://x",
        body: {},
        timeoutMs: 5_000,
        provider: "openai_compatible",
        log: nullLog(),
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
    }
  });

  it("decodeSse splits events at blank lines and drops [DONE] sentinel handling to caller", async () => {
    const chunks = [
      "data: {\"a\":1}\n\n",
      "data: {\"b\":2}\n\n",
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(new TextEncoder().encode(c));
        ctrl.close();
      },
    });
    const out: string[] = [];
    for await (const p of decodeSse(body)) out.push(p);
    expect(out).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
  });

  it("decodeSse tolerates chunks split mid-event", async () => {
    const pieces = [
      "data: {\"ok\"",
      ":true}\n\n",
      "data: {\"ok\":false}",
      "\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const p of pieces) ctrl.enqueue(new TextEncoder().encode(p));
        ctrl.close();
      },
    });
    const out: string[] = [];
    for await (const p of decodeSse(body)) out.push(p);
    expect(out).toEqual(['{"ok":true}', '{"ok":false}']);
  });
});
