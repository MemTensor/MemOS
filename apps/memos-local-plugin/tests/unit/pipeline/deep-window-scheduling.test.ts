import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { initTestLogger } from "../../../core/logger/index.js";
import { createMemoryCore, createPipeline, type PipelineHandle } from "../../../core/pipeline/index.js";
import { DEEP_PROCESSING_QUEUE_KEY } from "../../../core/pipeline/deep-window.js";
import type { EpisodeSnapshot } from "../../../core/session/types.js";
import type { EpisodeId, TraceId } from "../../../core/types.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

let db: TmpDbHandle;
let pipeline: PipelineHandle;
let core: MemoryCore;
let now: number;
let timers: Array<{ callback: () => void; delay: number }>;

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

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
});

afterEach(async () => {
  await core?.shutdown();
  db.cleanup();
  vi.restoreAllMocks();
});

function build(mode: "always" | "window" = "window", maxBatchPerCycle = 1): void {
  const config = structuredClone(DEFAULT_CONFIG);
  config.algorithm.lightweightMemory.enabled = false;
  config.algorithm.deepProcessing = {
    mode, window: "02:00-06:00", timezone: "UTC", drainIntervalSec: 3600, maxBatchPerCycle,
  };
  pipeline = createPipeline({
    agent: "openclaw", home: resolveHome("openclaw", db.dir), config,
    db: db.db, repos: db.repos, llm: null, reflectLlm: null,
    embedder: fakeEmbedder({ dimensions: 384 }), now: () => now,
    namespace: { agentKind: "openclaw", profileId: "main" },
  });
  core = createMemoryCore(pipeline, resolveHome("openclaw", db.dir), "test");
}

function seed(suffix: string): EpisodeSnapshot {
  const owner = { ownerAgentKind: "openclaw" as const, ownerProfileId: "main", ownerWorkspaceId: null };
  const episodeId = `ep_window_schedule_${suffix}` as EpisodeId;
  const sessionId = `se_window_schedule_${suffix}`;
  const traceId = `tr_window_schedule_${suffix}` as TraceId;
  db.repos.sessions.upsert({ id: sessionId, agent: "openclaw", ...owner, startedAt: now - 2000, lastSeenAt: now, meta: {} });
  db.repos.episodes.insert({ id: episodeId, sessionId, ...owner, startedAt: now - 2000, endedAt: now, traceIds: [traceId], rTask: null, status: "closed", meta: { closeReason: "finalized" } });
  db.repos.traces.insert({
    id: traceId, episodeId, sessionId, ...owner,
    ts: now - 1000, turnId: now - 2000,
    userText: "Explain how to recover a failed local database migration safely.",
    agentText: "Back up the database, inspect the migration journal, and retry the unapplied transaction.",
    toolCalls: [], reflection: null, alpha: 0, value: 0, rHuman: null,
    priority: 0, tags: [], vecSummary: null, vecAction: null, schemaVersion: 1,
  });
  const trace = db.repos.traces.getById(traceId)!;
  return {
    ...db.repos.episodes.getById(episodeId)!, turnCount: 2,
    turns: [
      { id: `${traceId}:user`, role: "user", content: trace.userText!, ts: trace.turnId! },
      { id: `${traceId}:assistant`, role: "assistant", content: trace.agentText!, ts: trace.ts },
    ],
    meta: { closeReason: "finalized" },
    intent: { kind: "task", confidence: 1, reason: "test", signals: [], retrieval: { tier1: true, tier2: true, tier3: true } },
  };
}

function fire(source: "queue" | "scan"): void {
  const delay = source === "queue" ? 60_000 : 600_000;
  timers.findLast((timer) => timer.delay === delay)!.callback();
}

async function settle(): Promise<void> {
  await nextTick();
  await pipeline.flush();
  await nextTick();
}

describe("deep window batch admission", () => {
  it.each(["queue", "scan"] as const)("shares the one-hour interval when %s runs first", async (first) => {
    build();
    await core.init();
    await core.waitForStartupRecovery?.();
    for (const suffix of ["1", "2", "3"]) {
      pipeline.buses.session.emit({ kind: "episode.finalized", episode: seed(suffix), closedBy: "finalized" });
    }
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    now = Date.parse("2026-09-06T03:00:00Z");
    fire(first);
    await settle();
    expect(reflect).toHaveBeenCalledTimes(1);
    now += 600_000;
    fire(first === "queue" ? "scan" : "queue");
    await settle();
    expect(reflect).toHaveBeenCalledTimes(1);
    now += 3_000_000;
    fire("scan");
    fire("queue");
    await settle();
    expect(reflect).toHaveBeenCalledTimes(2);
  });

  it("shares one batch budget across simultaneous queue and scan callbacks", async () => {
    build("window", 2);
    await core.init();
    for (const suffix of ["1", "2", "3", "4", "5"]) {
      pipeline.buses.session.emit({ kind: "episode.finalized", episode: seed(suffix), closedBy: "finalized" });
    }
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    now = Date.parse("2026-09-06T03:00:00Z");
    fire("scan");
    fire("queue");
    await settle();
    expect(reflect).toHaveBeenCalledTimes(2);
  });

  it("charges startup recovery against the same interval as timers", async () => {
    build();
    for (const suffix of ["1", "2", "3"]) {
      const episode = seed(suffix);
      pipeline.deepWindow.enqueue(episode.id, "finalized");
    }
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    now = Date.parse("2026-09-06T03:00:00Z");
    await core.init();
    await core.waitForStartupRecovery?.();
    expect(reflect).toHaveBeenCalledTimes(1);
    now += 600_000;
    fire("queue");
    fire("scan");
    await settle();
    expect(reflect).toHaveBeenCalledTimes(1);
    now += 3_000_000;
    fire("queue");
    await settle();
    expect(reflect).toHaveBeenCalledTimes(2);
  });

  it("recovers lost queue entries without spending a batch on an empty tick", async () => {
    build();
    await core.init();
    for (const suffix of ["1", "2"]) {
      pipeline.buses.session.emit({ kind: "episode.finalized", episode: seed(suffix), closedBy: "finalized" });
    }
    db.repos.kv.set(DEEP_PROCESSING_QUEUE_KEY, []);
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    now = Date.parse("2026-09-06T03:00:00Z");
    fire("queue");
    fire("scan");
    await settle();
    expect(reflect).toHaveBeenCalledTimes(1);
    now += 600_000;
    fire("scan");
    await settle();
    expect(reflect).toHaveBeenCalledTimes(1);
    now += 3_000_000;
    fire("scan");
    await settle();
    expect(reflect).toHaveBeenCalledTimes(2);
  });

  it("preserves retry backoff when a queued row and a dirty scan overlap", async () => {
    build();
    await core.init();
    const episode = seed("backoff");
    pipeline.buses.session.emit({ kind: "episode.finalized", episode, closedBy: "finalized" });
    now = Date.parse("2026-09-06T03:00:00Z");
    db.repos.episodes.updateMeta(episode.id, { rewardDirty: { failedAttempts: 3, lastFailureAt: now } });
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    fire("queue");
    fire("scan");
    await settle();
    expect(reflect).not.toHaveBeenCalled();
    now += 3_600_000;
    fire("scan");
    await settle();
    expect(reflect).toHaveBeenCalledTimes(1);
  });

  it("keeps always-mode startup recovery uncapped", async () => {
    build("always");
    for (const suffix of ["1", "2", "3"]) seed(suffix);
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    await core.init();
    await core.waitForStartupRecovery?.();
    expect(reflect).toHaveBeenCalledTimes(3);
  });
});
