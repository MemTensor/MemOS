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
  return {
    ...db.repos.episodes.getById(episodeId)!, turns: [], turnCount: 2,
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
