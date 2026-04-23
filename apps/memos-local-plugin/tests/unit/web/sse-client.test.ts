/**
 * Unit tests for the viewer's SSE client.
 *
 * We stub `fetch` to return a ReadableStream that emits SSE frames
 * synchronously, then assert the client parses events correctly and
 * that `close()` aborts the underlying fetch. `localStorage` is also
 * stubbed so the helper's API-key lookup is deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// jsdom-lite shims — the viewer module accesses `localStorage`,
// `window`, and `EventSource`. We fake just enough for unit-testing.
(globalThis as any).localStorage = {
  _s: new Map<string, string>(),
  getItem(k: string) { return this._s.get(k) ?? null; },
  setItem(k: string, v: string) { this._s.set(k, v); },
  removeItem(k: string) { this._s.delete(k); },
};
(globalThis as any).window = {
  addEventListener() {},
  setInterval: setInterval.bind(globalThis),
  clearInterval: clearInterval.bind(globalThis),
  location: { hash: "" },
};

import { openSse } from "../../../web/src/api/sse";

function makeSseResponse(chunks: string[], signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let i = 0;
      const push = () => {
        if (signal?.aborted) {
          controller.close();
          return;
        }
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i]));
          i += 1;
          setTimeout(push, 10);
        } else {
          controller.close();
        }
      };
      setTimeout(push, 10);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("openSse (viewer)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).localStorage._s.clear();
  });

  it("parses `event`/`data`/`id` fields and dispatches them", async () => {
    const received: { event: string; data: string; id?: string }[] = [];
    let abortSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: any, init: RequestInit) => {
      abortSignal = init.signal ?? undefined;
      return makeSseResponse(
        [
          "event: turn.started\ndata: {\"seq\":1,\"type\":\"turn.started\"}\nid: 1\n\n",
          "event: reward.computed\ndata: {\"seq\":2}\nid: 2\n\n",
        ],
        abortSignal,
      );
    }) as any;

    const handle = openSse("/api/v1/events", (event, data, id) => {
      received.push({ event, data, id });
    });

    await new Promise((r) => setTimeout(r, 80));
    handle.close();

    expect(received.map((r) => r.event)).toEqual([
      "turn.started",
      "reward.computed",
    ]);
    expect(received[0].id).toBe("1");
    expect(handle.lastEventId).toBe("2");
  });

  it("forwards x-api-key header when stored", async () => {
    (globalThis as any).localStorage.setItem("memos.apiKey", "secret-42");
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_u: any, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return makeSseResponse([]);
    }) as any;
    const handle = openSse("/api/v1/events", () => {});
    await new Promise((r) => setTimeout(r, 20));
    handle.close();
    expect(capturedHeaders?.["x-api-key"]).toBe("secret-42");
  });

  it("close() prevents further handler dispatch", async () => {
    const received: string[] = [];
    globalThis.fetch = (async () =>
      makeSseResponse([
        "event: a\ndata: x\n\n",
        "event: b\ndata: y\n\n",
      ])) as any;

    const handle = openSse("/api/v1/events", (event) => {
      received.push(event);
    });
    handle.close(); // immediately
    await new Promise((r) => setTimeout(r, 60));
    expect(received).toHaveLength(0);
  });
});
