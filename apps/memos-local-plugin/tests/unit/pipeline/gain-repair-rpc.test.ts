/**
 * `policies.gainPreview` + `policies.gainRollback` RPC tests.
 *
 * RED-GREEN: this suite was written FIRST against the spec/plan contract
 * (read-only preview, policy-field CAS rollback) and run before the
 * implementation existed (expected: import/method failures). The
 * implementation (`core/memory/l2/gain-maintenance.ts` + contract/dispatcher/
 * core wiring) was then built to satisfy it.
 *
 * Strategy: boot a REAL core on a tmp DB (the gain-repair-timer pattern) so
 * the tests exercise the actual memory-core wiring (live config slice,
 * thresholds, exact-namespace owner), drive repair ticks through the real
 * repair engine to produce journal rows, and cover dispatcher routing with a
 * stub core. No Python, no Ops CLI, no deployment.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryCore,
  createPipeline,
  type PipelineDeps,
  type PipelineHandle,
} from "../../../core/pipeline/index.js";
import type {
  GainPreviewResult,
  GainRollbackResult,
  MemoryCore,
} from "../../../agent-contract/memory-core.js";
import { RPC_METHODS } from "../../../agent-contract/jsonrpc.js";
import { makeDispatcher } from "../../../bridge/methods.js";
import { rootLogger } from "../../../core/logger/index.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import {
  GAIN_INFERENCE_VERSION,
  GAIN_POST_CUTOVER_BOUNDARY_MS,
} from "../../../core/reward/gain-inference.js";
import {
  consumeGainRepairRescreen,
  gainRepairBudgetKey,
  gainRepairRescreenKey,
  readGainRepairBudget,
  reserveGainRepairAttempt,
  runGainRepairTick,
  configVersionOf,
  type GainRepairAttemptDeps,
  type GainRepairOwner,
  type GainRepairTickResult,
} from "../../../core/memory/l2/gain-repair.js";
import type { L2Config } from "../../../core/memory/l2/types.js";
import type {
  EpisodeId,
  GainValueSource,
  PolicyId,
  PolicyRow,
  SessionId,
  TraceId,
} from "../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";

const NOW = 1_700_000_000_000;
const OWNER_A: GainRepairOwner = {
  ownerAgentKind: "openclaw",
  ownerProfileId: "default",
  ownerWorkspaceId: null,
};
const OWNER_B: GainRepairOwner = {
  ownerAgentKind: "openclaw",
  ownerProfileId: "other",
  ownerWorkspaceId: null,
};
const NS_A = { agentKind: "openclaw", profileId: "default" } as const;
const NS_B = { agentKind: "openclaw", profileId: "other" } as const;
const NS_UNKNOWN = { agentKind: "unknown", profileId: "default" } as const;
const THRESHOLDS = { minSupport: 2, minGain: 0.04, archiveGain: -0.05 };

function baseConfig(overrides: Partial<L2Config> = {}): L2Config {
  return {
    minSimilarity: 0.8,
    candidateTtlDays: 30,
    gamma: 0.9,
    tauSoftmax: 0.5,
    useLlm: true,
    minTraceValue: 0.01,
    minEpisodesForInduction: 1,
    inductionTraceCharCap: 2_000,
    gainEmaAlpha: 0.4,
    gainV2Enabled: true,
    minGainValue: 0.02,
    gainRepairBatchSize: 25,
    gainRepairIntervalMs: 900_000,
    gainRepairMaxTotal: 25,
    gainRepairRescreenGeneration: 0,
    ...overrides,
  };
}

function bootConfig(): typeof DEFAULT_CONFIG {
  return {
    ...DEFAULT_CONFIG,
    algorithm: {
      ...DEFAULT_CONFIG.algorithm,
      l2Induction: {
        ...DEFAULT_CONFIG.algorithm.l2Induction,
        gainV2Enabled: true,
        gainRepairBatchSize: 25,
        gainRepairMaxTotal: 25,
        gainRepairIntervalMs: 900_000,
        gainRepairRescreenGeneration: 0,
      },
    },
  };
}

let handle: TmpDbHandle | null = null;
let pipeline: PipelineHandle | null = null;
let core: MemoryCore | null = null;

function buildDeps(h: TmpDbHandle, config: typeof DEFAULT_CONFIG): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-gr-rpc"),
    config,
    db: h.db,
    repos: h.repos,
    llm: null,
    reflectLlm: null,
    entityLlm: null,
    l3Llm: null,
    embedder: fakeEmbedder({ dimensions: 384 }),
    log: rootLogger.child({ channel: "test.gain_repair_rpc" }),
    namespace: { agentKind: "openclaw", profileId: "default" },
    now: () => NOW,
  };
}

async function boot(config: typeof DEFAULT_CONFIG = bootConfig()): Promise<void> {
  handle = makeTmpDb();
  pipeline = createPipeline(buildDeps(handle, config));
  core = createMemoryCore(pipeline, resolveHome("openclaw", "/tmp/memos-gr-rpc"), "test", {
    autoRecovery: false,
  });
  await core.init();
}

afterEach(async () => {
  if (core) {
    try {
      await core.shutdown();
    } catch {
      /* ignore */
    }
    core = null;
    pipeline = null;
  }
  if (handle) {
    handle.cleanup();
    handle = null;
  }
});

interface SeedOpts {
  id: string;
  status?: "candidate" | "active";
  support?: number;
  gain?: number;
  gainVersion?: number;
  title?: string;
  evidenceGainValue?: number | null;
  evidenceSource?: GainValueSource | null;
  evidenceTs?: number;
  owner?: GainRepairOwner;
  queue?: "pending" | "blocked" | null;
  queueReason?: "inferred_evidence_updated" | "inference_refresh" | null;
}

/** Seed one policy + one evidence trace + link (+ queue entry), mirroring the engine tests. */
function seedPolicy(opts: SeedOpts): void {
  const h = handle!;
  const owner = opts.owner ?? OWNER_A;
  const episodeId = `ep_${opts.id}`;
  const sessionId = owner.ownerProfileId === "other" ? "s_other" : "s_rec";
  const traceId = `tr_${opts.id}`;
  if (!h.repos.sessions.getById(sessionId as SessionId)) {
    h.repos.sessions.upsert({
      id: sessionId as SessionId,
      agent: "openclaw",
      startedAt: NOW,
      lastSeenAt: NOW,
      meta: {},
    });
  }
  if (!h.repos.episodes.getById(episodeId as EpisodeId)) {
    h.repos.episodes.insert({
      id: episodeId as EpisodeId,
      sessionId: sessionId as SessionId,
      startedAt: NOW,
      endedAt: NOW,
      status: "closed",
      rTask: null,
      traceIds: [],
      meta: {},
      // Production-consistent ownership: the inference screen rejects
      // episode/trace owner mismatches as mixed_ownership, so the episode
      // carries the same owner as its traces.
      ownerAgentKind: owner.ownerAgentKind,
      ownerProfileId: owner.ownerProfileId,
      ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
    });
  }
  const gainValue = opts.evidenceGainValue === undefined ? 0.6 : opts.evidenceGainValue;
  const source: GainValueSource | null =
    opts.evidenceSource !== undefined
      ? opts.evidenceSource
      : gainValue == null
        ? null
        : "inferred_normalized";
  h.repos.traces.insert({
    id: traceId as TraceId,
    episodeId: episodeId as EpisodeId,
    sessionId: sessionId as SessionId,
    ts: opts.evidenceTs ?? NOW,
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
    gainValueSource: source,
    gainInferenceVersion: GAIN_INFERENCE_VERSION,
    ownerAgentKind: owner.ownerAgentKind,
    ownerProfileId: owner.ownerProfileId,
    ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
  });
  h.repos.episodes.appendTrace(episodeId as EpisodeId, [traceId]);
  h.repos.policies.insert({
    id: opts.id as PolicyId,
    title: opts.title ?? `title ${opts.id}`,
    trigger: "tr",
    procedure: "p",
    verification: "v",
    boundary: "b",
    support: opts.support ?? 0,
    gain: opts.gain ?? 0,
    gainVersion: opts.gainVersion ?? 1,
    status: opts.status ?? "candidate",
    sourceEpisodeIds: [],
    inducedBy: "unit",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: null,
    createdAt: NOW,
    updatedAt: NOW,
    sourceTraceIds: [traceId as TraceId],
    ownerAgentKind: owner.ownerAgentKind,
    ownerProfileId: owner.ownerProfileId,
    ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
  } as PolicyRow);
  h.repos.tracePolicyLinks.link({
    traceId: traceId as TraceId,
    policyId: opts.id as PolicyId,
    episodeId: episodeId as EpisodeId,
    now: NOW,
  });
  const queue = opts.queue === undefined ? "pending" : opts.queue;
  if (queue === "pending") {
    h.repos.gainRepair.upsertPending({
      policyId: opts.id as PolicyId,
      ownerAgentKind: owner.ownerAgentKind,
      ownerProfileId: owner.ownerProfileId,
      ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
      reason: opts.queueReason ?? "inferred_evidence_updated",
      inferenceVersion: GAIN_INFERENCE_VERSION,
      now: NOW,
    });
  } else if (queue === "blocked") {
    h.repos.gainRepair.upsertBlocked({
      policyId: opts.id as PolicyId,
      ownerAgentKind: owner.ownerAgentKind,
      ownerProfileId: owner.ownerProfileId,
      ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
      reason: opts.queueReason ?? "inferred_evidence_updated",
      blockedReason: "no_resolved_with",
      inferenceVersion: GAIN_INFERENCE_VERSION,
      now: NOW,
    });
  }
}

function engineDeps(
  h: TmpDbHandle,
  config: L2Config,
  owner: GainRepairOwner,
  extra: Partial<GainRepairAttemptDeps> = {},
): GainRepairAttemptDeps {
  return {
    db: h.db,
    repos: h.repos,
    config,
    owner,
    thresholds: THRESHOLDS,
    log: rootLogger.child({ channel: "test.gain_repair_rpc" }),
    now: () => NOW,
    inferenceVersion: GAIN_INFERENCE_VERSION,
    ...extra,
  };
}

function preConsumeRescreen(h: TmpDbHandle, owner: GainRepairOwner): void {
  h.repos.kv.set(gainRepairRescreenKey(owner), {
    generation: 0,
    inferenceVersion: GAIN_INFERENCE_VERSION,
    consumedAt: NOW,
  });
}

/** One real engine tick (pre-consumed rescreen so selection is purely queue-driven). */
function tick(
  h: TmpDbHandle,
  owner: GainRepairOwner,
  overrides: Partial<L2Config> = {},
): GainRepairTickResult {
  preConsumeRescreen(h, owner);
  return runGainRepairTick(engineDeps(h, baseConfig(overrides), owner));
}

const SNAPSHOT_TABLES = [
  "policies",
  "traces",
  "episodes",
  "trace_policy_links",
  "gain_repair_queue",
  "gain_repair_journal",
  "kv",
  "sessions",
];

function snapshot(h: TmpDbHandle): string {
  return JSON.stringify(
    SNAPSHOT_TABLES.map((t) => h.db.raw.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()),
  );
}

// ─── policies.gainPreview ────────────────────────────────────────────────────

describe("policies.gainPreview (read-only)", () => {
  it("repeated preview leaves all tables byte-identical", async () => {
    await boot();
    const h = handle!;
    seedPolicy({ id: "po_pv1", support: 2 });
    seedPolicy({ id: "po_pv2", status: "active", support: 3, gain: 0.1, gainVersion: 2 });
    const before = snapshot(h);
    const first = (await core!.previewGainRepair({ namespace: { ...NS_A } })) as GainPreviewResult;
    const mid = snapshot(h);
    const second = (await core!.previewGainRepair({ namespace: { ...NS_A } })) as GainPreviewResult;
    const after = snapshot(h);
    // ZERO writes: every table byte-identical across both previews.
    expect(mid).toBe(before);
    expect(after).toBe(before);
    expect(second).toEqual(first);
    expect(first.total).toBe(2);
  });

  it("ranks candidates by proposed gain desc, support desc, ID asc with stable pagination", async () => {
    await boot();
    seedPolicy({ id: "po_tie_b", evidenceGainValue: 0.5, support: 3 });
    seedPolicy({ id: "po_tie_a", evidenceGainValue: 0.5, support: 3 });
    seedPolicy({ id: "po_mid", evidenceGainValue: 0.5, support: 5 });
    seedPolicy({ id: "po_hi", evidenceGainValue: 0.9, support: 0 });
    seedPolicy({ id: "po_act", status: "active", support: 5, evidenceGainValue: 0.9 });
    const full = (await core!.previewGainRepair({
      namespace: { ...NS_A },
      limit: 50,
    })) as GainPreviewResult;
    expect(full.total).toBe(5);
    const order = full.policies.map((p) => p.policyId);
    // Candidates first (proposed gain desc, then support desc, then ID asc),
    // actives sort after every candidate.
    expect(order).toEqual(["po_hi", "po_mid", "po_tie_a", "po_tie_b", "po_act"]);
    const page1 = (await core!.previewGainRepair({
      namespace: { ...NS_A },
      limit: 2,
      offset: 0,
    })) as GainPreviewResult;
    const page2 = (await core!.previewGainRepair({
      namespace: { ...NS_A },
      limit: 2,
      offset: 2,
    })) as GainPreviewResult;
    const page3 = (await core!.previewGainRepair({
      namespace: { ...NS_A },
      limit: 2,
      offset: 4,
    })) as GainPreviewResult;
    expect(page1.policies.map((p) => p.policyId)).toEqual(["po_hi", "po_mid"]);
    expect(page2.policies.map((p) => p.policyId)).toEqual(["po_tie_a", "po_tie_b"]);
    expect(page3.policies.map((p) => p.policyId)).toEqual(["po_act"]);
    expect(page1.total).toBe(5);
    // Deterministic across calls.
    const again = (await core!.previewGainRepair({
      namespace: { ...NS_A },
      limit: 50,
    })) as GainPreviewResult;
    expect(again.policies.map((p) => p.policyId)).toEqual(order);
  });

  it("scopes exactly to the requested namespace — nothing leaks across owners", async () => {
    await boot();
    seedPolicy({ id: "po_a1", owner: OWNER_A });
    seedPolicy({ id: "po_b1", owner: OWNER_B });
    const a = (await core!.previewGainRepair({ namespace: { ...NS_A } })) as GainPreviewResult;
    const b = (await core!.previewGainRepair({ namespace: { ...NS_B } })) as GainPreviewResult;
    expect(a.policies.map((p) => p.policyId)).toEqual(["po_a1"]);
    expect(b.policies.map((p) => p.policyId)).toEqual(["po_b1"]);
    expect(a.queue.pending).toBe(1);
    expect(b.queue.pending).toBe(1);
  });

  it("rejects a missing namespace instead of guessing one", async () => {
    await boot();
    await expect(core!.previewGainRepair({} as never)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(core!.rollbackGainRepair({ batchId: "gr_nope" } as never)).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("reports proposed transitions, skip reasons, queue state and budget readback", async () => {
    await boot();
    const h = handle!;
    // Qualifying candidate (support 2, strong evidence) → promote proposal.
    seedPolicy({ id: "po_qual", support: 2, evidenceGainValue: 0.8 });
    // Weak candidate → retained.
    seedPolicy({ id: "po_weak", support: 0, evidenceGainValue: 0.01 });
    // Active → retained (repair never archives).
    seedPolicy({ id: "po_keep", status: "active", support: 4, gain: 0.2, gainVersion: 2 });
    // Blocked queue entry surfaces its state.
    seedPolicy({ id: "po_blk", queue: "blocked", evidenceGainValue: null });
    const res = (await core!.previewGainRepair({ namespace: { ...NS_A } })) as GainPreviewResult;
    const byId = new Map(res.policies.map((p) => [p.policyId, p]));
    expect(byId.get("po_qual")!.proposedTransition).toBe("promote_to_active");
    expect(byId.get("po_qual")!.skipReason).toBeNull();
    expect(byId.get("po_qual")!.newGainVersion).toBe(2);
    expect(byId.get("po_qual")!.queue!.state).toBe("pending");
    expect(byId.get("po_weak")!.proposedTransition).toBe("retain_candidate");
    expect(byId.get("po_keep")!.proposedTransition).toBe("retain_active");
    const blk = byId.get("po_blk")!;
    expect(blk.skipReason).toBe("no_resolved_with");
    expect(blk.proposedTransition).toBe("none");
    expect(blk.queue!.state).toBe("blocked");
    // Budget readback before any tick: uninitialized counter, live limit.
    expect(res.budget).toEqual({ attempted: 0, limit: 25, remaining: 25, initialized: false });
    expect(res.inferenceVersion).toBe(GAIN_INFERENCE_VERSION);
    // After one budgeted tick the same readback reflects the durable counter.
    const tickRes = tick(h, OWNER_A);
    expect(tickRes.attempted).toBeGreaterThan(0);
    const after = (await core!.previewGainRepair({ namespace: { ...NS_A } })) as GainPreviewResult;
    expect(after.budget.attempted).toBe(tickRes.attempted);
    expect(after.budget.limit).toBe(25);
    expect(after.budget.remaining).toBe(25 - tickRes.attempted);
  });

  it("reports unknown-owner policies as skips without mutating them", async () => {
    await boot();
    const h = handle!;
    seedPolicy({
      id: "po_uo",
      owner: { ownerAgentKind: "unknown", ownerProfileId: "default", ownerWorkspaceId: null },
    });
    const before = snapshot(h);
    const res = (await core!.previewGainRepair({
      namespace: { ...NS_UNKNOWN },
    })) as GainPreviewResult;
    expect(res.policies.map((p) => p.policyId)).toEqual(["po_uo"]);
    expect(res.policies[0]!.skipReason).toBe("unknown_owner");
    expect(res.policies[0]!.unknownOwner).toBe(true);
    expect(snapshot(h)).toBe(before);
  });

  it("summarizes post-cutover legacy and unknown-chronology cohorts", async () => {
    await boot();
    // One legacy trace per cohort episode; unlinked so they touch no policy entry.
    seedPolicy({
      id: "po_leg_post",
      evidenceGainValue: 0.4,
      evidenceSource: "legacy_unscaled",
      evidenceTs: GAIN_POST_CUTOVER_BOUNDARY_MS + 86_400_000,
      queue: null,
    });
    seedPolicy({
      id: "po_leg_pre",
      evidenceGainValue: 0.4,
      evidenceSource: "legacy_unscaled",
      evidenceTs: GAIN_POST_CUTOVER_BOUNDARY_MS - 86_400_000,
      queue: null,
    });
    seedPolicy({
      id: "po_leg_unk",
      evidenceGainValue: 0.4,
      evidenceSource: "legacy_unscaled",
      evidenceTs: 0,
      queue: null,
    });
    const res = (await core!.previewGainRepair({ namespace: { ...NS_A } })) as GainPreviewResult;
    expect(res.legacy.groups).toBe(3);
    expect(res.legacy.traces).toBe(3);
    expect(res.legacy.postCutoverGroups).toBe(1);
    expect(res.legacy.postCutoverTraces).toBe(1);
    expect(res.legacy.unknownChronologyGroups).toBe(1);
    expect(res.legacy.unknownChronologyTraces).toBe(1);
  });
});

// ─── policies.gainRollback ───────────────────────────────────────────────────

describe("policies.gainRollback (policy-field CAS)", () => {
  it("restores gain/version/status on CAS match, preserves support/evidence, never refunds budget", async () => {
    await boot();
    const h = handle!;
    seedPolicy({ id: "po_rb", support: 3, gain: 0.05, evidenceGainValue: 0.8 });
    const tickRes = tick(h, OWNER_A);
    expect(tickRes.attempted).toBe(1);
    const batchId = tickRes.batchId;
    const rows = h.repos.gainRepair.listJournalByBatch(batchId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.result).toBe("completed");
    expect(row.newStatus).toBe("active");
    const repaired = h.repos.policies.getById("po_rb" as PolicyId)!;
    expect(repaired.status).toBe("active");
    expect(repaired.gainVersion).toBe(2);
    const budgetBefore = readGainRepairBudget(h.repos.kv, OWNER_A, 25);
    const tracesBefore = JSON.stringify(
      h.db.raw.prepare(`SELECT * FROM "traces" ORDER BY rowid`).all(),
    );
    const out = (await core!.rollbackGainRepair({
      namespace: { ...NS_A },
      batchId,
    })) as GainRollbackResult;
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rolledBack).toEqual([{ journalId: row.id, policyId: "po_rb" }]);
    const after = h.repos.policies.getById("po_rb" as PolicyId)!;
    // Repair-owned fields restored to the journaled pre-repair values…
    expect(after.gain).toBe(0.05);
    expect(after.gainVersion).toBe(1);
    expect(after.status).toBe("candidate");
    // …with a FRESH updated_at (never a historical timestamp)…
    expect(after.updatedAt).toBeGreaterThan(repaired.updatedAt);
    // …support preserved and no trace/link touched…
    expect(after.support).toBe(3);
    expect(JSON.stringify(h.db.raw.prepare(`SELECT * FROM "traces" ORDER BY rowid`).all())).toBe(
      tracesBefore,
    );
    // …budget never refunded…
    const budgetAfter = readGainRepairBudget(h.repos.kv, OWNER_A, 25);
    expect(budgetAfter.attempted).toBe(budgetBefore.attempted);
    // …journal marked rolled_back and the queue entry parked blocked atomically.
    expect(h.repos.gainRepair.listJournalByBatch(batchId)[0]!.result).toBe("rolled_back");
    const entry = h.repos.gainRepair.getByPolicy("po_rb" as PolicyId)!;
    expect(entry.state).toBe("blocked");
    expect(entry.blockedReason).toBe("rolled_back");
  });

  it.each([
    ["support", { support: 4 }],
    ["gain", { gain: 0.99 }],
    ["status", { status: "archived" }],
    ["gain_version", { gainVersion: 1 }],
    ["updated_at", { bumpUpdatedAt: true }],
  ])(
    "rejects the whole batch with zero writes on a newer %s write",
    async (_field, patch) => {
      await boot();
      const h = handle!;
      seedPolicy({ id: "po_cf", support: 3, gain: 0.05, evidenceGainValue: 0.8 });
      seedPolicy({ id: "po_cf2", support: 3, gain: 0.05, evidenceGainValue: 0.8 });
      const tickRes = tick(h, OWNER_A);
      expect(tickRes.attempted).toBe(2);
      const repaired = h.repos.policies.getById("po_cf" as PolicyId)!;
      // A newer writer touches exactly one CAS field of the first policy.
      h.repos.policies.updateStats("po_cf" as PolicyId, {
        support: (patch as { support?: number }).support ?? repaired.support,
        gain: (patch as { gain?: number }).gain ?? repaired.gain,
        gainVersion: (patch as { gainVersion?: number }).gainVersion ?? repaired.gainVersion!,
        status: ((patch as { status?: string }).status ?? repaired.status) as PolicyRow["status"],
        updatedAt:
          (patch as { bumpUpdatedAt?: boolean }).bumpUpdatedAt === true
            ? repaired.updatedAt + 5
            : repaired.updatedAt,
      });
      const before = snapshot(h);
      const budgetBefore = readGainRepairBudget(h.repos.kv, OWNER_A, 25);
      const out = (await core!.rollbackGainRepair({
        namespace: { ...NS_A },
        batchId: tickRes.batchId,
      })) as GainRollbackResult;
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.conflicts).toHaveLength(1);
      expect(out.conflicts[0]!.policyId).toBe("po_cf");
      // ZERO writes: the untouched second policy is NOT rolled back either.
      expect(snapshot(h)).toBe(before);
      expect(readGainRepairBudget(h.repos.kv, OWNER_A, 25).attempted).toBe(
        budgetBefore.attempted,
      );
      expect(h.repos.policies.getById("po_cf2" as PolicyId)!.gainVersion).toBe(2);
    },
  );

  it("allows rollback when only trace/link evidence changed", async () => {
    await boot();
    const h = handle!;
    seedPolicy({ id: "po_ev", support: 3, gain: 0.05, evidenceGainValue: 0.8 });
    const tickRes = tick(h, OWNER_A);
    const repaired = h.repos.policies.getById("po_ev" as PolicyId)!;
    // Newer evidence arrives (trace + link) but no policy field is rewritten.
    h.repos.traces.insert({
      id: "tr_ev_new" as TraceId,
      episodeId: "ep_po_ev" as EpisodeId,
      sessionId: "s_rec" as SessionId,
      ts: NOW + 1,
      userText: "",
      agentText: "",
      toolCalls: [],
      reflection: null,
      value: 0.7,
      alpha: 0.5,
      rHuman: 0.5,
      priority: 0,
      tags: [],
      vecSummary: null,
      vecAction: null,
      turnId: 0,
      schemaVersion: 1,
      gainValue: 0.7,
      gainValueSource: "live_normalized",
      gainInferenceVersion: GAIN_INFERENCE_VERSION,
      ownerAgentKind: OWNER_A.ownerAgentKind,
      ownerProfileId: OWNER_A.ownerProfileId,
      ownerWorkspaceId: null,
    });
    h.repos.episodes.appendTrace("ep_po_ev" as EpisodeId, ["tr_ev_new"]);
    h.repos.tracePolicyLinks.link({
      traceId: "tr_ev_new" as TraceId,
      policyId: "po_ev" as PolicyId,
      episodeId: "ep_po_ev" as EpisodeId,
      now: NOW + 1,
    });
    const out = (await core!.rollbackGainRepair({
      namespace: { ...NS_A },
      batchId: tickRes.batchId,
    })) as GainRollbackResult;
    expect(out.ok).toBe(true);
    const after = h.repos.policies.getById("po_ev" as PolicyId)!;
    expect(after.gain).toBe(0.05);
    expect(after.status).toBe("candidate");
    // The newer evidence itself is never reverted.
    expect(h.repos.traces.getGainRowsByIds(["tr_ev_new"]).length).toBe(1);
    expect(repaired.support).toBe(after.support);
  });

  it("rejects cross-namespace rollback even when fields would match (nothing leaked)", async () => {
    await boot();
    const h = handle!;
    seedPolicy({ id: "po_ns", support: 3, gain: 0.05, evidenceGainValue: 0.8 });
    const tickRes = tick(h, OWNER_A);
    const row = h.repos.gainRepair.listJournalByBatch(tickRes.batchId)[0]!;
    const before = snapshot(h);
    // Batch scope: a foreign namespace sees no such batch.
    await expect(
      core!.rollbackGainRepair({ namespace: { ...NS_B }, batchId: tickRes.batchId }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(snapshot(h)).toBe(before);
    // Explicit IDs: rejected as forbidden WITHOUT echoing the policy id.
    const out = (await core!.rollbackGainRepair({
      namespace: { ...NS_B },
      journalIds: [row.id],
    })) as GainRollbackResult;
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]!.journalId).toBe(row.id);
    expect(out.conflicts[0]!.policyId).toBeNull();
    expect(snapshot(h)).toBe(before);
    // The owning namespace can still roll back afterwards.
    const ok = (await core!.rollbackGainRepair({
      namespace: { ...NS_A },
      batchId: tickRes.batchId,
    })) as GainRollbackResult;
    expect(ok.ok).toBe(true);
  });

  it("rejects a mixed-ownership batch as a whole without partial rollback", async () => {
    await boot();
    const h = handle!;
    seedPolicy({ id: "po_mix", support: 3, gain: 0.05, evidenceGainValue: 0.8 });
    const tickRes = tick(h, OWNER_A);
    // Foreign completed row sharing the same batch: eligible on its own
    // merits, so only the cross-namespace conflict can block the batch.
    // (Seeded as a real B-owned policy: the FK requires it, and its
    // untouched state afterwards proves nothing leaked across namespaces.)
    seedPolicy({ id: "po_mix_foreign", owner: OWNER_B, support: 2, gain: 0.1, evidenceGainValue: 0.8 });
    h.repos.gainRepair.insertJournal({
      id: "jj_mix_foreign",
      batchId: tickRes.batchId,
      ownerAgentKind: OWNER_B.ownerAgentKind,
      ownerProfileId: OWNER_B.ownerProfileId,
      ownerWorkspaceId: null,
      policyId: "po_mix_foreign" as PolicyId,
      oldGain: 0,
      newGain: 0.5,
      oldGainVersion: 1,
      newGainVersion: 2,
      oldStatus: "candidate",
      newStatus: "active",
      oldSupport: 2,
      newSupport: 2,
      algorithmVersion: "gain-repair.v1",
      configVersion: "test",
      inferenceVersion: GAIN_INFERENCE_VERSION,
      provenance: [],
      excludedWithCount: 0,
      excludedWithoutCount: 0,
      result: "completed",
      createdAt: NOW,
      newUpdatedAt: NOW,
    });
    const before = snapshot(h);
    const out = (await core!.rollbackGainRepair({
      namespace: { ...NS_A },
      batchId: tickRes.batchId,
    })) as GainRollbackResult;
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The foreign row blocks the batch without leaking its policy linkage,
    // and the own row is NOT partially applied.
    const foreign = out.conflicts.find((c) => c.journalId === "jj_mix_foreign");
    expect(foreign).toMatchObject({ policyId: null });
    expect(snapshot(h)).toBe(before);
  });

  it("rolls back by explicit journal IDs and refuses double rollback", async () => {
    await boot();
    const h = handle!;
    seedPolicy({ id: "po_ids", support: 3, gain: 0.05, evidenceGainValue: 0.8 });
    const tickRes = tick(h, OWNER_A);
    const row = h.repos.gainRepair.listJournalByBatch(tickRes.batchId)[0]!;
    const first = (await core!.rollbackGainRepair({
      namespace: { ...NS_A },
      journalIds: [row.id],
    })) as GainRollbackResult;
    expect(first.ok).toBe(true);
    const before = snapshot(h);
    const second = (await core!.rollbackGainRepair({
      namespace: { ...NS_A },
      journalIds: [row.id],
    })) as GainRollbackResult;
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.conflicts[0]!.reason).toBe("not_rollback_eligible");
    expect(snapshot(h)).toBe(before);
  });

  it("refuses non-completed and pre-timestamp journal rows", async () => {
    await boot();
    const h = handle!;
    seedPolicy({ id: "po_nc", queue: "blocked", evidenceGainValue: null });
    h.repos.gainRepair.insertJournal({
      id: "jj_blocked",
      batchId: "gr_manual",
      ownerAgentKind: OWNER_A.ownerAgentKind,
      ownerProfileId: OWNER_A.ownerProfileId,
      ownerWorkspaceId: null,
      policyId: "po_nc" as PolicyId,
      oldGain: 0,
      newGain: null,
      oldGainVersion: 1,
      newGainVersion: null,
      oldStatus: "candidate",
      newStatus: null,
      oldSupport: 0,
      newSupport: null,
      algorithmVersion: "gain-repair.v1",
      configVersion: "test",
      inferenceVersion: GAIN_INFERENCE_VERSION,
      provenance: [],
      excludedWithCount: 1,
      excludedWithoutCount: 0,
      result: "blocked",
      createdAt: NOW,
      newUpdatedAt: null,
    });
    // A completed row journaled WITHOUT the post-write timestamp (NULL
    // new_updated_at) is not CAS-safe and must be refused.
    h.repos.gainRepair.insertJournal({
      id: "jj_legacy",
      batchId: "gr_manual",
      ownerAgentKind: OWNER_A.ownerAgentKind,
      ownerProfileId: OWNER_A.ownerProfileId,
      ownerWorkspaceId: null,
      policyId: "po_nc" as PolicyId,
      oldGain: 0,
      newGain: 0.5,
      oldGainVersion: 1,
      newGainVersion: 2,
      oldStatus: "candidate",
      newStatus: "active",
      oldSupport: 2,
      newSupport: 2,
      algorithmVersion: "gain-repair.v1",
      configVersion: "test",
      inferenceVersion: GAIN_INFERENCE_VERSION,
      provenance: [],
      excludedWithCount: 0,
      excludedWithoutCount: 0,
      result: "completed",
      createdAt: NOW,
      newUpdatedAt: null,
    });
    const before = snapshot(h);
    const out = (await core!.rollbackGainRepair({
      namespace: { ...NS_A },
      journalIds: ["jj_blocked", "jj_legacy"],
    })) as GainRollbackResult;
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.conflicts.map((c) => c.journalId).sort()).toEqual(["jj_blocked", "jj_legacy"]);
    expect(snapshot(h)).toBe(before);
  });

  it("resumes rolled-back entries through the config re-screen generation", async () => {
    await boot();
    const h = handle!;
    seedPolicy({ id: "po_rs", support: 3, gain: 0.05, evidenceGainValue: 0.8 });
    const tickRes = tick(h, OWNER_A);
    const rolled = (await core!.rollbackGainRepair({
      namespace: { ...NS_A },
      batchId: tickRes.batchId,
    })) as GainRollbackResult;
    expect(rolled.ok).toBe(true);
    const budgetBefore = readGainRepairBudget(h.repos.kv, OWNER_A, 25);
    // Bumping the re-screen generation requeues the rolled-back entry as a
    // NEW budgeted attempt (never a refund: the counter only advances).
    const rescreen = consumeGainRepairRescreen(
      engineDeps(h, baseConfig({ gainRepairRescreenGeneration: 1 }), OWNER_A),
    );
    expect(rescreen.consumed).toBe(true);
    expect(rescreen.requeued).toBe(1);
    expect(h.repos.gainRepair.getByPolicy("po_rs" as PolicyId)!.state).toBe("pending");
    expect(readGainRepairBudget(h.repos.kv, OWNER_A, 25).attempted).toBe(
      budgetBefore.attempted,
    );
  });
});

// ─── Drive-by polish (Gate 3 notes) ─────────────────────────────────────────

describe("drive-by polish", () => {
  it("configVersionOf fingerprints batch/maxTotal/interval/generation", () => {
    const fp = configVersionOf(baseConfig());
    expect(fp).toContain("v2=1");
    expect(fp).toContain("ema=0.4");
    expect(fp).toContain("minGain=0.02");
    expect(fp).toContain("batch=25");
    expect(fp).toContain("maxTotal=25");
    expect(fp).toContain("interval=900000");
    expect(fp).toContain("gen=0");
  });

  it("corrupt budget JSON fails closed: no reset, no attempts, counter untouched", async () => {
    await boot();
    const h = handle!;
    seedPolicy({ id: "po_corrupt", support: 3, evidenceGainValue: 0.8 });
    h.repos.kv.set(gainRepairBudgetKey(OWNER_A), { attempted: "25", initializedAt: NOW });
    const storedBefore = h.repos.kv.get(gainRepairBudgetKey(OWNER_A), null);
    const res = tick(h, OWNER_A);
    expect(res.attempted).toBe(0);
    // The corrupt value is never overwritten with a fresh counter…
    expect(h.repos.kv.get(gainRepairBudgetKey(OWNER_A), null)).toEqual(storedBefore);
    // …the policy is untouched and no journal row was written…
    expect(h.repos.policies.getById("po_corrupt" as PolicyId)!.gainVersion).toBe(1);
    expect(h.repos.gainRepair.listJournalByBatch(res.batchId)).toHaveLength(0);
    // …and the readback reports no remaining budget (fail closed).
    const readback = readGainRepairBudget(h.repos.kv, OWNER_A, 25);
    expect(readback.remaining).toBe(0);
    expect(readback.initialized).toBe(true);
  });

  it("reserve refuses another namespace's queue entry without consuming budget", async () => {
    await boot();
    const h = handle!;
    seedPolicy({ id: "po_foreign", owner: OWNER_B });
    preConsumeRescreen(h, OWNER_A);
    const before = h.repos.kv.get(gainRepairBudgetKey(OWNER_A), null);
    const out = reserveGainRepairAttempt(
      engineDeps(h, baseConfig(), OWNER_A),
      "po_foreign" as PolicyId,
      "gr_probe",
    );
    expect(out.kind).toBe("not_pending");
    expect(h.repos.kv.get(gainRepairBudgetKey(OWNER_A), null)).toEqual(before);
    expect(h.repos.gainRepair.getByPolicy("po_foreign" as PolicyId)!.state).toBe("pending");
  });
});

// ─── Dispatcher routing ──────────────────────────────────────────────────────

describe("gain maintenance dispatcher routing", () => {
  const PREVIEW_RESULT = { total: 0 } as unknown as GainPreviewResult;
  const ROLLBACK_RESULT = {
    ok: true,
    batchId: null,
    rolledBack: [],
    rolledBackAt: 0,
  } as GainRollbackResult;

  function stubDispatch() {
    const stub = {
      previewGainRepair: vi.fn(async () => PREVIEW_RESULT),
      rollbackGainRepair: vi.fn(async () => ROLLBACK_RESULT),
    } as unknown as MemoryCore;
    return { stub, dispatch: makeDispatcher(stub) };
  }

  it("routes policies.gainPreview with an exact namespace and pagination", async () => {
    const { stub, dispatch } = stubDispatch();
    const out = await dispatch(RPC_METHODS.POLICIES_GAIN_PREVIEW, {
      namespace: { agentKind: "openclaw", profileId: "default" },
      limit: 10,
      offset: 5,
    });
    expect(out).toBe(PREVIEW_RESULT);
    expect(stub.previewGainRepair).toHaveBeenCalledWith({
      namespace: { agentKind: "openclaw", profileId: "default" },
      limit: 10,
      offset: 5,
    });
  });

  it("rejects preview/rollback without an exact namespace", async () => {
    const { dispatch } = stubDispatch();
    await expect(dispatch(RPC_METHODS.POLICIES_GAIN_PREVIEW, {})).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      dispatch(RPC_METHODS.POLICIES_GAIN_ROLLBACK, { batchId: "gr_1" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("routes policies.gainRollback by batch or IDs, never both/neither", async () => {
    const { stub, dispatch } = stubDispatch();
    const ns = { namespace: { agentKind: "openclaw", profileId: "default" } };
    await dispatch(RPC_METHODS.POLICIES_GAIN_ROLLBACK, { ...ns, batchId: "gr_1" });
    expect(stub.rollbackGainRepair).toHaveBeenCalledWith({ ...ns, batchId: "gr_1" });
    await dispatch(RPC_METHODS.POLICIES_GAIN_ROLLBACK, { ...ns, journalIds: ["jj_1"] });
    expect(stub.rollbackGainRepair).toHaveBeenCalledWith({ ...ns, journalIds: ["jj_1"] });
    await expect(dispatch(RPC_METHODS.POLICIES_GAIN_ROLLBACK, ns)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      dispatch(RPC_METHODS.POLICIES_GAIN_ROLLBACK, { ...ns, batchId: "gr_1", journalIds: [] }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
});
