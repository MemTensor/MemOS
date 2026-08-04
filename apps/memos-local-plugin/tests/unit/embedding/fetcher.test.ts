import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MemosError } from "../../../agent-contract/errors.js";
import { initTestLogger } from "../../../core/logger/index.js";
import { httpPostJson } from "../../../core/embedding/fetcher.js";
import type { ProviderLogger } from "../../../core/embedding/types.js";
import { clearRetryCooldowns } from "../../../core/util/retry-after.js";

function nullLogger(): ProviderLogger {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("embedding/fetcher", () => {
  beforeAll(() => initTestLogger());
  beforeEach(() => {
    vi.useRealTimers(); // retry backoff uses real setTimeout; keep it real but short
  });
  afterEach(() => {
    clearRetryCooldowns();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mockFetch(responses: Array<Response | Error>) {
    let i = 0;
    const fetchMock = vi.fn(async () => {
      const r = responses[i++];
      if (!r) throw new Error("mockFetch exhausted");
      if (r instanceof Error) throw r;
      return r;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns parsed JSON on 200", async () => {
    const f = mockFetch([
      new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 }),
    ]);
    const res = await httpPostJson<{ data: Array<{ embedding: number[] }> }>({
      url: "https://x",
      body: { a: 1 },
      provider: "openai_compatible",
      log: nullLogger(),
    });
    expect(res.data[0]!.embedding).toEqual([0.1]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 and then succeeds", async () => {
    const f = mockFetch([
      new Response("oops", { status: 500 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const res = await httpPostJson<{ ok: boolean }>({
      url: "https://x",
      body: {},
      provider: "openai_compatible",
      log: nullLogger(),
      maxRetries: 2,
    });
    expect(res.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 then succeeds", async () => {
    const f = mockFetch([
      new Response("rate limited", { status: 429 }),
      new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    ]);
    await httpPostJson({
      url: "https://x",
      body: {},
      provider: "cohere",
      log: nullLogger(),
      maxRetries: 1,
    });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After HTTP-date before retrying a 429", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    const f = mockFetch([
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "Tue, 04 Aug 2026 00:00:03 GMT" },
      }),
      new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    ]);

    const pending = httpPostJson<{ ok: number }>({
      url: "https://x",
      body: {},
      provider: "cohere",
      log: nullLogger(),
      maxRetries: 1,
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("defers a long Retry-After and short-circuits the provider cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    const f = mockFetch([
      new Response("maintenance", { status: 503, headers: { "Retry-After": "120" } }),
    ]);
    const opts = {
      url: "https://embedding-x",
      body: {},
      provider: "cohere" as const,
      log: nullLogger(),
      maxRetries: 1,
    };

    await expect(httpPostJson(opts)).rejects.toMatchObject({
      code: "embedding_unavailable",
      details: {
        retryAfterMs: 120_000,
        retryDecision: "defer",
        retryReason: "retry_after_too_long",
      },
    });
    await expect(httpPostJson(opts)).rejects.toMatchObject({
      code: "embedding_unavailable",
      details: { retryReason: "cooldown_active" },
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("returns structured diagnostics when network backoff cannot fit the deadline", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-04T00:00:00.000Z");
    vi.setSystemTime(now);
    const f = mockFetch([new Error("ECONNRESET")]);

    await expect(httpPostJson({
      url: "https://embedding-deadline",
      body: {},
      provider: "mistral",
      log: nullLogger(),
      maxRetries: 1,
      deadlineAt: now + 100,
    })).rejects.toMatchObject({
      name: "MemosError",
      code: "embedding_unavailable",
      details: {
        retryDecision: "defer",
        retryReason: "deadline_insufficient",
      },
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 400", async () => {
    mockFetch([new Response("bad", { status: 400 })]);
    await expect(
      httpPostJson({
        url: "https://x",
        body: {},
        provider: "cohere",
        log: nullLogger(),
        maxRetries: 3,
      }),
    ).rejects.toBeInstanceOf(MemosError);
  });

  it("throws MemosError with embedding_unavailable on exhausted retries", async () => {
    mockFetch([
      new Response("a", { status: 500 }),
      new Response("b", { status: 500 }),
      new Response("c", { status: 500 }),
    ]);
    try {
      await httpPostJson({
        url: "https://x",
        body: {},
        provider: "voyage",
        log: nullLogger(),
        maxRetries: 2,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe("embedding_unavailable");
      expect((err as MemosError).details).toMatchObject({
        provider: "voyage",
        status: 500,
      });
    }
  });

  it("maps network errors to MemosError", async () => {
    mockFetch([new Error("ECONNRESET")]);
    try {
      await httpPostJson({
        url: "https://x",
        body: {},
        provider: "mistral",
        log: nullLogger(),
        maxRetries: 0,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe("embedding_unavailable");
      expect((err as MemosError).details).toMatchObject({ provider: "mistral" });
    }
  });

  it("merges an external AbortSignal", async () => {
    const ctrl = new AbortController();
    mockFetch([
      new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    ]);
    // We just ensure it doesn't throw when signal is passed.
    await httpPostJson({
      url: "https://x",
      body: {},
      provider: "gemini",
      log: nullLogger(),
      signal: ctrl.signal,
    });
  });
});
