import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MemosError } from "../../../agent-contract/errors.js";
import { decodeSse, httpPostJson, httpPostStream } from "../../../core/llm/fetcher.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type { LlmProviderLogger } from "../../../core/llm/types.js";
import { clearRetryCooldowns } from "../../../core/util/retry-after.js";

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
  afterEach(() => {
    clearRetryCooldowns();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("honors Retry-After delay-seconds before retrying a 429", async () => {
    vi.useFakeTimers();
    const f = mockFetch([
      new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }),
      new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    ]);

    const pending = httpPostJson({
      url: "https://x",
      body: {},
      timeoutMs: 5_000,
      maxRetries: 1,
      provider: "openai_compatible",
      log: nullLog(),
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ json: { ok: 1 } });
    expect(f).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("aborts while waiting for Retry-After", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const f = mockFetch([
      new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }),
    ]);

    const pending = httpPostJson({
      url: "https://x",
      body: {},
      timeoutMs: 5_000,
      maxRetries: 1,
      signal: ctrl.signal,
      provider: "openai_compatible",
      log: nullLog(),
    });
    await vi.advanceTimersByTimeAsync(0);
    ctrl.abort();
    await expect(pending).rejects.toBeInstanceOf(MemosError);
    expect(f).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("defers a long Retry-After from a 503 without retrying early", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    const warn = vi.fn();
    const f = mockFetch([
      new Response("maintenance", { status: 503, headers: { "Retry-After": "120" } }),
    ]);

    const pending = httpPostJson({
      url: "https://x",
      body: {},
      timeoutMs: 120_000,
      maxRetries: 1,
      provider: "openai_compatible",
      log: { ...nullLog(), warn },
    });
    await expect(pending).rejects.toMatchObject({
      code: "llm_unavailable",
      details: {
        retryAfterMs: 120_000,
        retryDecision: "defer",
        retryReason: "retry_after_too_long",
      },
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "http.retry_deferred",
      expect.objectContaining({
        retryAfterMs: 120_000,
        retryDecision: "defer",
        retryReason: "retry_after_too_long",
      }),
    );
  });

  it("short-circuits calls while the provider Retry-After cooldown is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    const warn = vi.fn();
    const f = mockFetch([
      new Response("slow down", { status: 429, headers: { "Retry-After": "120" } }),
    ]);
    const opts = {
      url: "https://x",
      body: {},
      timeoutMs: 5_000,
      maxRetries: 1,
      provider: "openai_compatible" as const,
      log: { ...nullLog(), warn },
    };

    await expect(httpPostJson(opts)).rejects.toMatchObject({ code: "llm_rate_limited" });
    await expect(httpPostJson(opts)).rejects.toMatchObject({
      code: "llm_rate_limited",
      details: { retryDecision: "defer", retryReason: "cooldown_active" },
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "http.retry_cooldown",
      expect.objectContaining({ retryReason: "cooldown_active" }),
    );
  });

  it("does not enter a Retry-After wait that cannot fit the absolute deadline", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-04T00:00:00.000Z");
    vi.setSystemTime(now);
    const f = mockFetch([
      new Response("slow down", { status: 429, headers: { "Retry-After": "5" } }),
    ]);

    await expect(httpPostJson({
      url: "https://deadline",
      body: {},
      timeoutMs: 5_000,
      maxRetries: 1,
      deadlineAt: now + 1_000,
      provider: "openai_compatible",
      log: nullLog(),
    })).rejects.toMatchObject({
      code: "llm_rate_limited",
      details: {
        retryDecision: "defer",
        retryReason: "deadline_insufficient",
      },
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("returns structured diagnostics when network backoff cannot fit the deadline", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-04T00:00:00.000Z");
    vi.setSystemTime(now);
    const f = mockFetch([new Error("ECONNRESET")]);

    await expect(httpPostJson({
      url: "https://network-deadline",
      body: {},
      timeoutMs: 5_000,
      maxRetries: 1,
      deadlineAt: now + 100,
      provider: "openai_compatible",
      log: nullLog(),
    })).rejects.toMatchObject({
      name: "MemosError",
      code: "llm_unavailable",
      details: {
        retryDecision: "defer",
        retryReason: "deadline_insufficient",
      },
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not let an older in-flight success clear a newer provider cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    let resolveSuccess!: (response: Response) => void;
    const success = new Promise<Response>((resolve) => { resolveSuccess = resolve; });
    const f = vi.fn()
      .mockImplementationOnce(() => success)
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "Retry-After": "120" } }),
      );
    vi.stubGlobal("fetch", f);
    const opts = {
      url: "https://shared-endpoint",
      body: {},
      timeoutMs: 5_000,
      maxRetries: 1,
      provider: "openai_compatible" as const,
      log: nullLog(),
    };

    const older = httpPostJson<{ ok: boolean }>(opts);
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await expect(httpPostJson(opts)).rejects.toMatchObject({
      details: { retryReason: "retry_after_too_long" },
    });
    resolveSuccess(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(older).resolves.toMatchObject({ json: { ok: true } });

    await expect(httpPostJson(opts)).rejects.toMatchObject({
      details: { retryReason: "cooldown_active" },
    });
    expect(f).toHaveBeenCalledTimes(2);
  });

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

  it("logs a truncated response body for non-ok JSON responses", async () => {
    const warn = vi.fn();
    const body = "x".repeat(600);
    mockFetch([new Response(body, { status: 400 })]);

    await expect(
      httpPostJson({
        url: "https://x",
        body: {},
        timeoutMs: 5_000,
        maxRetries: 0,
        provider: "openai_compatible",
        log: { ...nullLog(), warn },
      }),
    ).rejects.toBeInstanceOf(MemosError);

    expect(warn).toHaveBeenCalledWith(
      "http.non_ok",
      expect.objectContaining({
        status: 400,
        body: "x".repeat(512),
      }),
    );
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

  it("logs response body for non-ok streaming responses", async () => {
    const warn = vi.fn();
    mockFetch([new Response("stream rejected", { status: 400 })]);

    await expect(
      httpPostStream({
        url: "https://x",
        body: {},
        timeoutMs: 5_000,
        provider: "openai_compatible",
        log: { ...nullLog(), warn },
      }),
    ).rejects.toBeInstanceOf(MemosError);

    expect(warn).toHaveBeenCalledWith(
      "http.non_ok",
      expect.objectContaining({
        status: 400,
        body: "stream rejected",
      }),
    );
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
