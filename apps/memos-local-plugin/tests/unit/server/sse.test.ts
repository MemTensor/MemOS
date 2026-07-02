/**
 * HTTP server — SSE endpoint tests.
 *
 * The spec says `/api/v1/events` and `/api/v1/logs` are
 * Server-Sent-Event streams. Spinning up the server on a random port,
 * this test simulates a browser `EventSource` by reading the response
 * body line-by-line and checking that the expected frames appear.
 *
 * Subscribers are mocked on the core so the test can push events
 * synthetically without waiting on the real pipeline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startHttpServer } from "../../../server/index.js";
import type { ServerHandle } from "../../../server/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import type { CoreEvent } from "../../../agent-contract/events.js";
import type { LogRecord } from "../../../agent-contract/log-record.js";

type Emit<T> = (value: T) => void;

function stubCore(ref: { emitEvent: Emit<CoreEvent>; emitLog: Emit<LogRecord> }): MemoryCore {
  let eventSubscriber: ((e: CoreEvent) => void) | null = null;
  let logSubscriber: ((r: LogRecord) => void) | null = null;

  ref.emitEvent = (evt) => eventSubscriber?.(evt);
  ref.emitLog = (log) => logSubscriber?.(log);

  return {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    health: vi.fn(async () => ({}) as any),
    openSession: vi.fn(),
    closeSession: vi.fn(),
    openEpisode: vi.fn(),
    closeEpisode: vi.fn(),
    onTurnStart: vi.fn(),
    onTurnEnd: vi.fn(),
    submitFeedback: vi.fn(),
    recordToolOutcome: vi.fn(),
    searchMemory: vi.fn(),
    getTrace: vi.fn(),
    getPolicy: vi.fn(),
    getWorldModel: vi.fn(),
    listEpisodes: vi.fn(),
    timeline: vi.fn(),
    listSkills: vi.fn(),
    getSkill: vi.fn(),
    archiveSkill: vi.fn(),
    subscribeEvents: vi.fn((handler) => {
      eventSubscriber = handler;
      return () => { eventSubscriber = null; };
    }),
    subscribeLogs: vi.fn((handler) => {
      logSubscriber = handler;
      return () => { logSubscriber = null; };
    }),
    forwardLog: vi.fn(),
  } as unknown as MemoryCore;
}

async function readFrames(
  url: string,
  maxMs = 500,
): Promise<{ events: string[]; lines: string[] }> {
  const ac = new AbortController();
  const resp = await fetch(url, { signal: ac.signal });
  expect(resp.status).toBe(200);
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const lines: string[] = [];
  const events: string[] = [];

  // Abort after `maxMs`. This forces reader.read() to reject, ending the loop.
  const abortTimer = setTimeout(() => ac.abort(), maxMs);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
      while (buf.includes("\n")) {
        const idx = buf.indexOf("\n");
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        lines.push(line);
        if (line.startsWith("event: ")) events.push(line.slice(7).trim());
      }
    }
  } catch {
    // expected: AbortError on timeout
  } finally {
    clearTimeout(abortTimer);
    try { await reader.cancel(); } catch { /* noop */ }
  }
  return { events, lines };
}

describe("SSE /api/v1/events", () => {
  let handle: ServerHandle;
  const ref: any = {};

  beforeEach(async () => {
    const core = stubCore(ref);
    handle = await startHttpServer({ core }, { port: 0 });
  });

  afterEach(async () => {
    await handle.close();
  });

  it("streams CoreEvents as SSE frames", async () => {
    // Emit a synthetic event after a short delay so the server side has time to subscribe.
    setTimeout(() => {
      ref.emitEvent({
        type: "retrieval.started",
        ts: 1,
        seq: 1,
        payload: { sessionId: "s1" },
      });
    }, 50);

    const { events, lines } = await readFrames(`${handle.url}/api/v1/events`, 400);
    expect(events).toContain("retrieval.started");
    expect(lines.some((l) => l.startsWith("data: "))).toBe(true);
  });
});

describe("SSE /api/v1/logs", () => {
  let handle: ServerHandle;
  const ref: any = {};

  beforeEach(async () => {
    const core = stubCore(ref);
    const tail: LogRecord[] = [
      { ts: 1, level: "info", channel: "test", message: "first", context: {} } as any,
      { ts: 2, level: "warn", channel: "test", message: "second", context: {} } as any,
    ];
    handle = await startHttpServer({ core, logTail: () => tail }, { port: 0 });
  });

  afterEach(async () => {
    await handle.close();
  });

  it("GET /api/v1/logs/tail returns the stored tail", async () => {
    const r = await fetch(`${handle.url}/api/v1/logs/tail?n=50`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.logs).toHaveLength(2);
    expect(body.logs[0].message).toBe("first");
  });

  it("streams live LogRecords as SSE frames", async () => {
    setTimeout(() => {
      ref.emitLog({
        ts: 3,
        level: "info",
        channel: "test",
        message: "live-marker-xyz",
        context: {},
      } as any);
    }, 200);

    const { events, lines } = await readFrames(`${handle.url}/api/v1/logs`, 1200);
    expect(events.filter((e) => e === "log").length).toBeGreaterThanOrEqual(1);
    expect(lines.some((l) => l.includes("live-marker-xyz"))).toBe(true);
  });
});
