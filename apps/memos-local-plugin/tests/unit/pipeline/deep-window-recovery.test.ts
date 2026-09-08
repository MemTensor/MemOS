import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { initTestLogger } from "../../../core/logger/index.js";
import { createMemoryCore, createPipeline, type PipelineHandle } from "../../../core/pipeline/index.js";
import { DEEP_PROCESSING_QUEUE_KEY } from "../../../core/pipeline/deep-window.js";
import type { EpisodeSnapshot } from "../../../core/session/types.js";
import type { EpisodeId } from "../../../core/types.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

let db: TmpDbHandle;
let pipeline: PipelineHandle;
let core: MemoryCore;
let now: number;
let timers: Array<{ callback: () => void; delay: number }>;
const episodeId = "ep_window_review" as EpisodeId;

beforeEach(() => {
  initTestLogger();
  now = Date.parse("2026-09-05T14:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  timers = [];
  vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
    timers.push({ callback, delay });
    return { unref() {} } as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  db = makeTmpDb();
  const config = structuredClone(DEFAULT_CONFIG);
  config.algorithm.lightweightMemory.enabled = false;
  config.algorithm.deepProcessing = { mode: "window", window: "02:00-06:00", timezone: "UTC", drainIntervalSec: 600, maxBatchPerCycle: 1 };
  pipeline = createPipeline({
    agent: "openclaw", home: resolveHome("openclaw", db.dir), config,
    db: db.db, repos: db.repos, llm: null, reflectLlm: null,
    embedder: fakeEmbedder({ dimensions: 384 }), now: () => now,
    namespace: { agentKind: "openclaw", profileId: "main" },
  });
  core = createMemoryCore(pipeline, resolveHome("openclaw", db.dir), "test");
});

afterEach(async () => {
  await core.shutdown();
  db.cleanup();
  vi.restoreAllMocks();
});

function seed(): EpisodeSnapshot {
  const owner = { ownerAgentKind: "openclaw" as const, ownerProfileId: "main", ownerWorkspaceId: null };
  db.repos.sessions.upsert({ id: "se_window_review", agent: "openclaw", ...owner, startedAt: now - 2000, lastSeenAt: now, meta: {} });
  db.repos.episodes.insert({ id: episodeId, sessionId: "se_window_review", ...owner, startedAt: now - 2000, endedAt: now, traceIds: ["tr_window_review"] as never, rTask: null, status: "closed", meta: { closeReason: "finalized" } });
  db.repos.traces.insert({
    id: "tr_window_review", episodeId, sessionId: "se_window_review", ...owner,
    ts: now - 1000, turnId: now - 2000, userText: "Explain how to recover a failed local database migration safely.",
    agentText: "Back up the database, inspect the migration journal, and retry the unapplied transaction.",
    toolCalls: [], reflection: null, alpha: 0, value: 0, rHuman: null,
    priority: 0, tags: [], vecSummary: null, vecAction: null, schemaVersion: 1,
  });
  const trace = db.repos.traces.listAllForEpisode(episodeId)[0]!;
  return {
    ...db.repos.episodes.getById(episodeId)!, turnCount: 2,
    turns: [
      { id: `${trace.id}:user`, role: "user", content: trace.userText ?? "", ts: trace.turnId ?? trace.ts },
      { id: `${trace.id}:assistant`, role: "assistant", content: trace.agentText ?? "", ts: trace.ts },
    ],
    meta: { closeReason: "finalized" },
    intent: { kind: "task", confidence: 1, reason: "test", signals: [], retrieval: { tier1: true, tier2: true, tier3: true } },
  };
}

async function tick(): Promise<void> {
  timers.findLast((timer) => timer.delay === 60_000)!.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await pipeline.flush();
}

describe("deep window recovery coordination", () => {
  it.each([false, true])("preserves an abandoned episode's close reason (queue lost: %s)", async (loseQueue) => {
    const snapshot = seed();
    snapshot.meta.closeReason = "abandoned";
    snapshot.meta.abandonReason = "cancelled by user";
    db.repos.episodes.updateMeta(episodeId, snapshot.meta);
    await core.init();
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    pipeline.buses.session.emit({ kind: "episode.finalized", episode: snapshot, closedBy: "abandoned" });
    if (loseQueue) db.repos.kv.set(DEEP_PROCESSING_QUEUE_KEY, []);
    now = Date.parse("2026-09-06T03:00:00Z");
    if (loseQueue) {
      timers.find((timer) => timer.delay === 600_000)!.callback();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await pipeline.flush();
    } else {
      await tick();
    }
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(reflect).toHaveBeenCalledWith(expect.objectContaining({
      closedBy: "abandoned",
      episode: expect.objectContaining({ meta: expect.objectContaining({ closeReason: "abandoned" }) }),
    }));
    expect(db.repos.episodes.getById(episodeId)?.meta?.closeReason).toBe("abandoned");
  });

  it("acknowledges a completed chain even when its final work finishes after the window", async () => {
    const snapshot = seed();
    pipeline.deepWindow.enqueue(episodeId, "finalized");
    now = Date.parse("2026-09-06T05:59:59Z");
    await pipeline.captureRunner.runReflect({ episode: snapshot, closedBy: "finalized" });
    now = Date.parse("2026-09-06T06:00:01Z");
    await pipeline.flush();
    expect(db.repos.episodes.getById(episodeId)?.meta?.deepProcessingPending).not.toBe(true);
    expect(pipeline.deepWindow.size()).toBe(0);
  });

  it("keeps a newer deferred close pending when an older chain finishes", async () => {
    const snapshot = seed();
    now = Date.parse("2026-09-06T05:59:59Z");
    pipeline.buses.session.emit({ kind: "episode.finalized", episode: snapshot, closedBy: "finalized" });
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const drain = vi.spyOn(pipeline.l3, "drain").mockReturnValueOnce(blocked);
    const flushing = pipeline.flush();
    try {
      await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
      now = Date.parse("2026-09-06T14:00:00Z");
      const trace = db.repos.traces.getById(snapshot.traceIds[0]!)!;
      const nextTrace = { ...trace, id: "tr_window_late" as typeof trace.id, ts: now, turnId: now };
      db.repos.traces.insert(nextTrace);
      snapshot.traceIds = [...snapshot.traceIds, nextTrace.id];
      db.repos.episodes.appendTrace(episodeId, snapshot.traceIds);
      pipeline.buses.session.emit({ kind: "episode.finalized", episode: snapshot, closedBy: "finalized" });
      // Reward coverage can already include the new trace without reflecting it.
      db.repos.episodes.setRTask(episodeId, 0.8);
      db.repos.episodes.updateMeta(episodeId, { reward: { traceCount: 2, trigger: "explicit_feedback" } });
      now = Date.parse("2026-09-07T03:00:00Z");
    } finally {
      finish();
      await flushing;
      drain.mockRestore();
    }
    expect(db.repos.episodes.getById(episodeId)?.meta?.deepProcessingPending).toBe(true);
    expect(pipeline.deepWindow.size()).toBe(1);
  });

  it("does not replay a stale startup selection already completed by the queue drain", async () => {
    seed();
    const row = db.repos.episodes.getById(episodeId)!;
    db.repos.episodes.insert({
      ...row, id: "ep_window_orphan" as EpisodeId, status: "open", traceIds: [],
      startedAt: now - 86_400_000, endedAt: null, meta: {},
    });
    pipeline.deepWindow.enqueue(episodeId, "finalized");
    now = Date.parse("2026-09-06T03:00:00Z");
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    const originalFlush = pipeline.flush;
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const flush = vi.spyOn(pipeline, "flush").mockImplementationOnce(async () => {
      await blocked;
      await originalFlush();
    });
    try {
      await core.init();
      now += 60_000;
      await tick();
    } finally {
      finish();
      await core.waitForStartupRecovery?.();
      flush.mockRestore();
    }
    expect(reflect.mock.calls.filter(([input]) => input.episode.id === episodeId)).toHaveLength(1);
  });

  it("does not access recovery rows after shutdown has finished", async () => {
    const snapshot = seed();
    await core.init();
    pipeline.buses.session.emit({ kind: "episode.finalized", episode: snapshot, closedBy: "finalized" });
    now = Date.parse("2026-09-06T03:00:00Z");
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const flush = vi.spyOn(pipeline, "flush").mockReturnValueOnce(blocked);
    timers.findLast((timer) => timer.delay === 60_000)!.callback();
    expect(flush).toHaveBeenCalledTimes(1);
    try {
      await core.shutdown();
      // The caller may close SQLite as soon as shutdown resolves.
      const read = vi.spyOn(db.repos.episodes, "getById");
      finish();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(read).not.toHaveBeenCalled();
    } finally {
      finish();
      await new Promise<void>((resolve) => setImmediate(resolve));
      flush.mockRestore();
    }
  });

  it("acknowledges deferred work after switching back to always mode", async () => {
    seed();
    db.repos.episodes.updateMeta(episodeId, { deepProcessingPending: true });
    pipeline.deepWindow.enqueue(episodeId, "finalized");
    const config = structuredClone(pipeline.config);
    config.algorithm.deepProcessing.mode = "always";
    await core.shutdown();
    pipeline = createPipeline({
      agent: "openclaw", home: resolveHome("openclaw", db.dir), config,
      db: db.db, repos: db.repos, llm: null, reflectLlm: null,
      embedder: fakeEmbedder({ dimensions: 384 }), now: () => now,
      namespace: { agentKind: "openclaw", profileId: "main" },
    });
    core = createMemoryCore(pipeline, resolveHome("openclaw", db.dir), "test");
    await core.init();
    await core.waitForStartupRecovery?.();
    expect(db.repos.episodes.getById(episodeId)?.meta?.deepProcessingPending).not.toBe(true);
    expect(pipeline.deepWindow.size()).toBe(0);
  });

  it("removes a queued obligation after startup recovery completes", async () => {
    seed();
    pipeline.deepWindow.enqueue(episodeId, "finalized");
    now = Date.parse("2026-09-06T03:00:00Z");
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    await core.init();
    await core.waitForStartupRecovery?.();
    now += 60_000;
    await tick();
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(pipeline.deepWindow.size()).toBe(0);
  });

  it.each([false, true])("reflects a deferred, feedback-scored episode (queue lost: %s)", async (loseQueue) => {
    const snapshot = seed();
    await core.init();
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    pipeline.buses.session.emit({ kind: "episode.finalized", episode: snapshot, closedBy: "finalized" });
    expect(reflect).not.toHaveBeenCalled();
    // Explicit feedback updates reward coverage before the scheduled reflect pass.
    db.repos.episodes.setRTask(episodeId, 0.8);
    db.repos.episodes.updateMeta(episodeId, { reward: { traceCount: 1, trigger: "explicit_feedback" } });
    if (loseQueue) db.repos.kv.set(DEEP_PROCESSING_QUEUE_KEY, []);
    now = Date.parse("2026-09-06T03:00:00Z");
    if (loseQueue) {
      timers.find((timer) => timer.delay === 600_000)!.callback();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await pipeline.flush();
    } else {
      await tick();
    }
    await vi.waitFor(() => {
      expect(reflect).toHaveBeenCalledTimes(1);
      expect(db.repos.episodes.getById(episodeId)?.meta?.deepProcessingPending).not.toBe(true);
    });
  });

  it.each([false, true])("recovers a feedback-scored episode after its pending write fails (window open: %s)", async (windowOpen) => {
    const snapshot = seed();
    await core.init();
    if (windowOpen) now = Date.parse("2026-09-06T03:00:00Z");
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    const updateMeta = vi.spyOn(db.repos.episodes, "updateMeta").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    try {
      pipeline.buses.session.emit({ kind: "episode.finalized", episode: snapshot, closedBy: "finalized" });
      await pipeline.flush();
    } finally {
      updateMeta.mockRestore();
    }
    reflect.mockClear();
    // Explicit feedback can make reward coverage complete before reflection.
    db.repos.episodes.setRTask(episodeId, 0.8);
    db.repos.episodes.updateMeta(episodeId, { reward: { traceCount: 1, trigger: "explicit_feedback" } });
    now = Date.parse("2026-09-07T03:00:00Z");
    await tick();
    timers.find((timer) => timer.delay === 600_000)!.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await pipeline.flush();
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(db.repos.episodes.getById(episodeId)?.meta?.deepProcessingPending).not.toBe(true);
  });

  it.each(["session", "episode"] as const)("returns from %s close while evolution is waiting for tomorrow", async (kind) => {
    await core.init();
    const sessionId = await core.openSession({ agent: "openclaw" });
    const id = await core.openEpisode({ sessionId, userMessage: "test scheduled processing" });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const flush = vi.spyOn(pipeline, "flush").mockReturnValue(pending);
    let returned = false;
    const closing = (kind === "session" ? core.closeSession(sessionId) : core.closeEpisode(id))
      .then(() => { returned = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(returned).toBe(true);
    } finally {
      finish();
      await closing;
      flush.mockRestore();
    }
  });

  it("releases a close request when the window ends during its flush", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await core.init();
    const sessionId = await core.openSession({ agent: "openclaw" });
    const id = await core.openEpisode({ sessionId, userMessage: "test scheduled processing" });
    now = Date.parse("2026-09-06T05:59:59Z");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const flush = vi.spyOn(pipeline, "flush").mockReturnValue(pending);
    let returned = false;
    const closing = core.closeEpisode(id).then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(returned).toBe(false);
    now += 2000;
    await vi.advanceTimersByTimeAsync(1000);
    try {
      expect(returned).toBe(true);
    } finally {
      finish();
      await closing;
      flush.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["session", "episode"] as const)("releases %s close when shutdown abandons a blocked flush", async (kind) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await core.init();
    const sessionId = await core.openSession({ agent: "openclaw" });
    const id = await core.openEpisode({ sessionId, userMessage: "test scheduled processing" });
    now = Date.parse("2026-09-06T03:00:00Z");
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const drain = vi.spyOn(pipeline.l3, "drain").mockReturnValue(blocked);
    let returned = false;
    const closing = (kind === "session" ? core.closeSession(sessionId) : core.closeEpisode(id))
      .then(() => { returned = true; });
    let shuttingDown: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
      expect(returned).toBe(false);
      shuttingDown = core.shutdown();
      await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(19_000);
      await shuttingDown;
      expect(returned).toBe(true);
    } finally {
      finish();
      await closing;
      await shuttingDown;
      drain.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not replay a queued episode while startup recovery is still processing it", async () => {
    seed();
    pipeline.deepWindow.enqueue(episodeId, "finalized");
    now = Date.parse("2026-09-06T03:00:00Z");
    const original = pipeline.captureRunner.runReflect;
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect").mockImplementation(async (input) => {
      await blocked;
      return original(input);
    });
    await core.init();
    expect(reflect).toHaveBeenCalledTimes(1);
    now += 60_000;
    timers.findLast((timer) => timer.delay === 60_000)!.callback();
    try {
      expect(reflect).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await core.waitForStartupRecovery?.();
    }
  });
});
