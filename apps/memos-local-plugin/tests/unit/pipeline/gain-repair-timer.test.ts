/**
 * repair timer tests (core/pipeline/memory-core.ts).
 *
 * Fake-timer driven: the independent 15-minute periodic tick must drain the
 * repair queue with ZERO L2/reward traffic, stay single-flight (overlapping
 * ticks are skipped, not queued), do nothing when disabled/paused, never emit
 * `l2.failed` on repair errors, and clear + await in-flight work on shutdown.
 *
 * The gain-repair engine module is mocked (real implementation wrapped) so the
 * test can observe invocation count and inject controlled ticks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryCore,
  createPipeline,
  type PipelineDeps,
  type PipelineHandle,
} from "../../../core/pipeline/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { rootLogger } from "../../../core/logger/index.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { GAIN_INFERENCE_VERSION } from "../../../core/reward/gain-inference.js";
import { gainRepairBudgetKey } from "../../../core/memory/l2/gain-repair.js";
import type { PolicyId, TraceId, EpisodeId, SessionId } from "../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";

// Wrap the engine module so the timer's calls are observable AND the real
// engine still runs for the drain tests. `runGainRepairTick` becomes a mock.
vi.mock("../../../core/memory/l2/gain-repair.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../core/memory/l2/gain-repair.js")>();
  return {
    ...actual,
    runGainRepairTick: vi.fn(actual.runGainRepairTick),
  };
});

import { runGainRepairTick } from "../../../core/memory/l2/gain-repair.js";
const mockedTick = vi.mocked(runGainRepairTick);

const NOW = 1_700_000_000_000;
const INTERVAL_MS = 900_000;
const OWNER = { ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: null };

function repairEnabledConfig(): typeof DEFAULT_CONFIG {
  return {
    ...DEFAULT_CONFIG,
    algorithm: {
      ...DEFAULT_CONFIG.algorithm,
      l2Induction: {
        ...DEFAULT_CONFIG.algorithm.l2Induction,
        gainV2Enabled: true,
        gainRepairBatchSize: 25,
        gainRepairMaxTotal: null,
        gainRepairIntervalMs: INTERVAL_MS,
      },
    },
  };
}

function buildDeps(h: TmpDbHandle, config: typeof DEFAULT_CONFIG): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-gr-timer"),
    config,
    db: h.db,
    repos: h.repos,
    llm: null,
    reflectLlm: null,
    entityLlm: null,
    l3Llm: null,
    embedder: fakeEmbedder({ dimensions: 384 }),
    log: rootLogger.child({ channel: "test.gain-repair-timer" }),
    namespace: { agentKind: "openclaw", profileId: "default" },
    now: () => NOW,
  };
}

let db: TmpDbHandle | null = null;
let pipeline: PipelineHandle | null = null;
let core: MemoryCore | null = null;

function seedPendingPolicy(h: TmpDbHandle, id: string, opts: { gainValue?: number | null } = {}): void {
  const gainValue = opts.gainValue === undefined ? 0.6 : opts.gainValue;
  const episodeId = `ep_${id}`;
  const traceId = `tr_${id}`;
  // `sessions.upsert` is INSERT OR REPLACE: re-running it would DELETE the
  // session row and cascade-delete every episode (and its traces/links) of
  // this test session. Only create it when missing.
  if (!h.repos.sessions.getById("s_rec" as SessionId)) {
    h.repos.sessions.upsert({ id: "s_rec", agent: "openclaw", startedAt: NOW, lastSeenAt: NOW, meta: {} });
  }
  h.repos.episodes.insert({
    id: episodeId as EpisodeId,
    sessionId: "s_rec" as SessionId,
    startedAt: NOW,
    endedAt: NOW,
    status: "closed",
    rTask: null,
    traceIds: [],
    meta: {},
  });
  h.repos.traces.insert({
    id: traceId as TraceId,
    episodeId: episodeId as EpisodeId,
    sessionId: "s_rec" as SessionId,
    ts: NOW,
    userText: "",
    agentText: "",
    toolCalls: [],
    reflection: null,
    value: gainValue ?? 0.5,
    alpha: 0.5,
    rHuman: 0.5,
    priority: 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    turnId: 0,
    schemaVersion: 1,
    gainValue,
    gainValueSource: gainValue == null ? null : "inferred_normalized",
    gainInferenceVersion: GAIN_INFERENCE_VERSION,
  });
  h.repos.episodes.appendTrace(episodeId as EpisodeId, [traceId]);
  h.repos.policies.insert({
    id: id as PolicyId,
    title: "t",
    trigger: "tr",
    procedure: "p",
    verification: "v",
    boundary: "b",
    support: 0,
    gain: 0,
    gainVersion: 1,
    status: "candidate",
    sourceEpisodeIds: [],
    inducedBy: "unit",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: null,
    createdAt: NOW,
    updatedAt: NOW,
    sourceTraceIds: [traceId],
    ownerAgentKind: OWNER.ownerAgentKind,
    ownerProfileId: OWNER.ownerProfileId,
    ownerWorkspaceId: null,
  });
  h.repos.tracePolicyLinks.link({
    traceId: traceId as TraceId,
    policyId: id as PolicyId,
    episodeId: episodeId as EpisodeId,
    now: NOW,
  });
  h.repos.gainRepair.upsertPending({
    policyId: id as PolicyId,
    ownerAgentKind: OWNER.ownerAgentKind,
    ownerProfileId: OWNER.ownerProfileId,
    ownerWorkspaceId: null,
    reason: "inferred_evidence_updated",
    inferenceVersion: GAIN_INFERENCE_VERSION,
    now: NOW,
  });
}

async function boot(config: typeof DEFAULT_CONFIG): Promise<void> {
  pipeline = createPipeline(buildDeps(db!, config));
  core = createMemoryCore(
    pipeline,
    resolveHome("openclaw", "/tmp/memos-gr-timer"),
    "test",
    { autoRecovery: false },
  );
  await core.init();
}

beforeEach(() => {
  db = makeTmpDb();
  mockedTick.mockClear();
  // Fake timers + Date, but keep setImmediate real: the pipeline's startup
  // orphan reconcile (autoRecovery=false path) resolves its recovery promise
  // inside a setImmediate callback — starving it would hang core.shutdown().
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(async () => {
  vi.useRealTimers();
  if (core) {
    try {
      await core.shutdown();
    } catch {
      /* ignore */
    }
    core = null;
  } else if (pipeline) {
    try {
      await pipeline.shutdown("test.cleanup");
    } catch {
      /* ignore */
    }
  }
  pipeline = null;
  db?.cleanup();
  db = null;
});

describe("pipeline/gain-repair-timer", () => {
  it("does NOT run repair immediately at init — first attempt is on the first enabled tick", async () => {
    for (let i = 0; i < 3; i++) seedPendingPolicy(db!, `po_${i}`);
    await boot(repairEnabledConfig());
    expect(mockedTick).not.toHaveBeenCalled();
    // Budget not even initialized before the first tick.
    expect(db!.repos.kv.get(gainRepairBudgetKey(OWNER), null)).toBeNull();
  });

  it("drains the queue with zero L2/reward traffic after one 15-minute tick", async () => {
    for (let i = 0; i < 10; i++) seedPendingPolicy(db!, `po_${i}`);
    await boot(repairEnabledConfig());
    const qRows = db!.db.prepare<unknown, { policy_id: string; state: string; owner: string }>(
      `SELECT policy_id, state, COALESCE(owner_agent_kind,'?') || '/' || COALESCE(owner_profile_id,'?') || '/' || COALESCE(owner_workspace_id,'?') AS owner FROM gain_repair_queue ORDER BY policy_id`,
    ).all();
    // Sanity: every seeded entry is pending under the timer owner before the tick.
    expect(qRows).toHaveLength(10);
    expect(qRows.every((r) => r.state === "pending" && r.owner === "openclaw/default/?")).toBe(true);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    // Real engine ran inside the timer.
    expect(mockedTick).toHaveBeenCalledTimes(1);
    expect(db!.repos.kv.get<{ attempted: number } | null>(gainRepairBudgetKey(OWNER), null)?.attempted).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(db!.repos.gainRepair.getByPolicy(`po_${i}` as PolicyId)).toBeNull();
    }
  });

  it("disabled (batch size 0) and v2-off configs make the tick do nothing", async () => {
    for (let i = 0; i < 3; i++) seedPendingPolicy(db!, `po_${i}`);
    const paused = repairEnabledConfig();
    paused.algorithm.l2Induction.gainRepairBatchSize = 0;
    await boot(paused);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(mockedTick).not.toHaveBeenCalled(); // memory-core gates before the engine
    expect(db!.repos.kv.get(gainRepairBudgetKey(OWNER), null)).toBeNull();

    await core!.shutdown();
    core = null;
    const v2off = repairEnabledConfig();
    v2off.algorithm.l2Induction.gainV2Enabled = false;
    await boot(v2off);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(mockedTick).not.toHaveBeenCalled();
  });

  it("overlapping ticks are skipped, never queued (single-flight per namespace)", async () => {
    await boot(repairEnabledConfig());

    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeResult = {
      batchId: "gr_test",
      attempted: 1,
      rescored: 1,
      promoted: 0,
      blocked: 0,
      conflicted: 0,
      failed: 0,
      reconciled: 0,
      budget: { attempted: 1, limit: null, remaining: null },
      inferenceVersion: GAIN_INFERENCE_VERSION,
      rescreenConsumed: false,
      durationMs: 1,
    };
    mockedTick.mockImplementationOnce(() => gate.then(() => fakeResult) as unknown as ReturnType<typeof runGainRepairTick>);

    // First tick starts and stays in flight.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mockedTick).toHaveBeenCalledTimes(1);

    // An overlapping interval fires while the first tick is still running →
    // the callback must SKIP it (no queued/accumulated tick).
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mockedTick).toHaveBeenCalledTimes(1);

    // Release the in-flight tick; the next interval runs a fresh tick.
    release!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mockedTick).toHaveBeenCalledTimes(2);
  });

  it("timer errors never emit l2.failed and never write a policy_generate failure row", async () => {
    await boot(repairEnabledConfig());
    const l2Failed: string[] = [];
    pipeline!.buses.l2.onAny((evt) => {
      if (evt.kind === "l2.failed") l2Failed.push(evt.kind);
    });

    mockedTick.mockImplementation(() => {
      throw new Error("repair engine exploded");
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mockedTick).toHaveBeenCalledTimes(1);
    expect(l2Failed).toEqual([]);
    // The l2.failed subscriber is what writes policy_generate api_log rows;
    // zero rows proves nothing was emitted.
    expect(db!.repos.apiLogs.count({ toolName: "policy_generate" })).toBe(0);

    // The timer survives the error and keeps ticking.
    mockedTick.mockClear();
    mockedTick.mockImplementation(() => {
      throw new Error("again");
    });
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mockedTick).toHaveBeenCalledTimes(1);
  });

  it("shutdown clears the timer and waits for in-flight work before closing", async () => {
    await boot(repairEnabledConfig());

    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeResult = {
      batchId: "gr_shutdown",
      attempted: 0,
      rescored: 0,
      promoted: 0,
      blocked: 0,
      conflicted: 0,
      failed: 0,
      reconciled: 0,
      budget: { attempted: 0, limit: null, remaining: null },
      inferenceVersion: GAIN_INFERENCE_VERSION,
      rescreenConsumed: false,
      durationMs: 1,
    };
    mockedTick.mockImplementationOnce(() => gate.then(() => fakeResult) as unknown as ReturnType<typeof runGainRepairTick>);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mockedTick).toHaveBeenCalledTimes(1);

    // shutdown() must not complete while the tick is in flight.
    let shutdownDone = false;
    const shutdownPromise = core!.shutdown().then(() => {
      shutdownDone = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(shutdownDone).toBe(false);

    release!();
    await shutdownPromise;
    expect(shutdownDone).toBe(true);

    // Timer cleared — no further ticks.
    mockedTick.mockClear();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(mockedTick).not.toHaveBeenCalled();
  });
});
