/**
 * Stdio transport — round-trip tests.
 *
 * Connect the server to a pair of `PassThrough` streams and drive it
 * with the bundled client helper. Asserts:
 *   • request → success response routing.
 *   • request → error response with stable `code`.
 *   • notifications (events + logs) stream back unordered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import {
  createStdioClient,
  startStdioServer,
  waitForShutdown,
} from "../../../bridge/stdio.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

function stubCore(): MemoryCore {
  const subscribers: Array<(e: unknown) => void> = [];
  const logSubs: Array<(r: unknown) => void> = [];
  return {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    health: vi.fn(async () => ({
      ok: true,
      version: "t",
      uptimeMs: 1,
      agent: "openclaw",
      paths: { home: "", config: "", db: "", skills: "", logs: "" },
      llm: { available: false, provider: "" },
      embedder: { available: false, provider: "", dim: 0 },
    })),
    openSession: vi.fn(async ({ sessionId }) => sessionId ?? "s-auto"),
    closeSession: vi.fn(async () => {}),
    openEpisode: vi.fn(async ({ episodeId }) => episodeId ?? "e-auto"),
    closeEpisode: vi.fn(async () => {}),
    onTurnStart: vi.fn(async () => ({
      query: { agent: "openclaw", query: "" },
      hits: [],
      injectedContext: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    })),
    onTurnEnd: vi.fn(async () => ({ traceId: "tr-1", episodeId: "e-1" })),
    submitFeedback: vi.fn(async (fb) => ({
      id: "fb-1",
      ts: 1,
      channel: fb.channel,
      polarity: fb.polarity,
      magnitude: fb.magnitude,
    })),
    recordToolOutcome: vi.fn(),
    searchMemory: vi.fn(async (q) => ({
      query: q,
      hits: [],
      injectedContext: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    })),
    getTrace: vi.fn(async () => null),
    getPolicy: vi.fn(async () => null),
    getWorldModel: vi.fn(async () => null),
    listEpisodes: vi.fn(async () => []),
    timeline: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    getSkill: vi.fn(async () => null),
    archiveSkill: vi.fn(async () => {}),
    subscribeEvents: vi.fn((h: (e: unknown) => void) => {
      subscribers.push(h);
      return () => {
        const i = subscribers.indexOf(h);
        if (i >= 0) subscribers.splice(i, 1);
      };
    }) as any,
    subscribeLogs: vi.fn((h: (r: unknown) => void) => {
      logSubs.push(h);
      return () => {
        const i = logSubs.indexOf(h);
        if (i >= 0) logSubs.splice(i, 1);
      };
    }) as any,
    forwardLog: vi.fn(),
    _fire(evt: unknown) {
      for (const s of subscribers) s(evt);
    },
    _log(r: unknown) {
      for (const s of logSubs) s(r);
    },
  } as any;
}

function wire() {
  const clientOut = new PassThrough();
  const serverOut = new PassThrough();
  const core = stubCore();
  const server = startStdioServer({
    core,
    stdin: clientOut,
    stdout: serverOut,
    logToStderr: false,
  });
  const client = createStdioClient(serverOut, clientOut);
  return { core, server, client, clientOut, serverOut };
}

describe("stdio transport", () => {
  afterEach(() => vi.useRealTimers());

  it("round-trips a successful request", async () => {
    const { client } = wire();
    const res = await client.request<{ ok: boolean }>("core.init", {});
    expect(res).toEqual({ ok: true });
  });

  it("surfaces MemosError via the JSON-RPC error object", async () => {
    const { client } = wire();
    await expect(client.request("bogus.method", {})).rejects.toMatchObject({
      data: expect.objectContaining({ code: "unknown_method" }),
    });
  });

  it("delivers core events as notifications", async () => {
    const { core, client } = wire();
    const received: Array<{ method: string; params: unknown }> = [];
    const ingest = (async () => {
      for await (const note of client.notifications) {
        received.push(note);
        if (received.length >= 2) break;
      }
    })();
    // fire via the stub.
    (core as any)._fire({ type: "session.opened", payload: {}, ts: 1, seq: 1 });
    (core as any)._log({ ts: 1, level: "info", channel: "c", msg: "m" });
    await Promise.race([
      ingest,
      new Promise((resolve) => setTimeout(resolve, 200)),
    ]);
    expect(received.map((r) => r.method)).toEqual(
      expect.arrayContaining(["events.notify", "logs.forward"]),
    );
  });

  it("marks the server disconnected when stdin ends", async () => {
    const { server, clientOut } = wire();
    expect(server.connected).toBe(true);

    clientOut.end();
    await server.done;

    expect(server.connected).toBe(false);
  });

  it("waitForShutdown closes transport without waiting for stdin end", async () => {
    const { server, core } = wire();
    const finished = await Promise.race([
      waitForShutdown(core, server).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);

    expect(finished).toBe(true);
    expect(server.connected).toBe(false);
    expect(core.shutdown).toHaveBeenCalled();
  });

  it("cancels a pending server request when its signal aborts", async () => {
    const { server } = wire();
    const controller = new AbortController();
    const request = server.serverRequest(
      "host.llm.complete",
      {},
      { timeoutMs: 1_000, signal: controller.signal },
    );

    controller.abort(new Error("caller cancelled"));

    await expect(request).rejects.toThrow("caller cancelled");
  });

  it("does not send a server request when its signal is already aborted", async () => {
    const { server, serverOut } = wire();
    const controller = new AbortController();
    controller.abort(new Error("deadline passed"));

    await expect(
      server.serverRequest(
        "host.llm.complete",
        {},
        { timeoutMs: 1_000, signal: controller.signal },
      ),
    ).rejects.toThrow("deadline passed");
    expect(serverOut.read()).toBeNull();
  });

  it("cleans up concurrent cancelled server requests", async () => {
    vi.useFakeTimers();
    const { server } = wire();
    const controllers = Array.from({ length: 128 }, () => new AbortController());
    const requests = controllers.map((controller) =>
      server.serverRequest("host.llm.complete", {}, {
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    );

    for (const controller of controllers) {
      controller.abort(new Error("caller cancelled"));
    }

    const results = await Promise.allSettled(requests);
    expect(results).toHaveLength(128);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
