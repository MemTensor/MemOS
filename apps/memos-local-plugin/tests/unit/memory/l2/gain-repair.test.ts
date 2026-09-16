/**
 * Unit tests for `core/memory/l2/gain-repair.ts` — the per-policy
 * attempt engine: durable total-attempt budget in kv, atomic
 * reservation + per-policy recompute commits, interrupted-claim reconcile and
 * the config-generation re-screen.
 *
 * RED-GREEN: every scenario below targets the spec contract FIRST (failing),
 * then the engine was implemented to satisfy it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rootLogger } from "../../../../core/logger/index.js";
import type { L2Config } from "../../../../core/memory/l2/types.js";
import {
  applyGainRepairAttempt,
  consumeGainRepairRescreen,
  GAIN_REPAIR_BUDGET_KEY,
  gainRepairBudgetKey,
  gainRepairRescreenKey,
  readGainRepairBudget,
  reconcileInterruptedGainRepairClaims,
  reserveGainRepairAttempt,
  runGainRepairTick,
  type GainRepairAttemptDeps,
  type GainRepairOwner,
} from "../../../../core/memory/l2/gain-repair.js";
import { GAIN_INFERENCE_VERSION } from "../../../../core/reward/gain-inference.js";
import { recomputePolicyGain as realRecompute } from "../../../../core/memory/l2/recompute-gain.js";
import type {
  EpisodeId,
  GainValueSource,
  PolicyId,
  PolicyRow,
  SessionId,
  TraceId,
  TraceRow,
} from "../../../../core/types.js";
import { ensureEpisode } from "./_helpers.js";
import type { TmpDbHandle } from "../../../helpers/tmp-db.js";
import { makeTmpDb } from "../../../helpers/tmp-db.js";

const NOW = 1_700_000_000_000;
const OWNER: GainRepairOwner = {
  ownerAgentKind: "openclaw",
  ownerProfileId: "default",
  ownerWorkspaceId: null,
};

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
    gainRepairMaxTotal: null,
    gainRepairRescreenGeneration: 0,
    ...overrides,
  };
}

const THRESHOLDS = { minSupport: 2, minGain: 0.04, archiveGain: -0.05 };

function policyRow(overrides: Partial<PolicyRow> = {}): PolicyRow {
  return {
    id: "po_1" as PolicyRow["id"],
    title: "title",
    trigger: "trigger",
    procedure: "procedure",
    verification: "verification",
    boundary: "boundary",
    support: 0,
    gain: 0,
    gainVersion: 1,
    status: "candidate",
    sourceEpisodeIds: [],
    inducedBy: "unit-test",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface SeedPolicyOpts {
  id: string;
  status?: "candidate" | "active";
  support?: number;
  gain?: number;
  gainVersion?: number;
  /** Resolved gainValue for the evidence trace. Undefined = unresolved (NULL). */
  gainValue?: number | null;
  reason?: "inferred_evidence_updated" | "inference_refresh" | null;
  owner?: Partial<GainRepairOwner>;
  linkEvidence?: boolean;
  blocked?: boolean;
}

let handle: TmpDbHandle | null = null;

function seedPolicy(opts: SeedPolicyOpts): PolicyRow {
  const h = handle!;
  const owner = { ...OWNER, ...(opts.owner ?? {}) };
  const episodeId = `ep_${opts.id}`;
  const sessionId = "s_rec";
  const traceId = `tr_${opts.id}`;
  ensureEpisode(h, episodeId, sessionId);
  const gainValue = opts.gainValue === undefined ? 0.6 : opts.gainValue;
  const source: GainValueSource | null = gainValue == null ? null : "inferred_normalized";
  h.repos.traces.insert({
    id: traceId as TraceId,
    episodeId: episodeId as EpisodeId,
    sessionId: sessionId as SessionId,
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
    gainValueSource: source,
    gainInferenceVersion: GAIN_INFERENCE_VERSION,
    ownerAgentKind: owner.ownerAgentKind,
    ownerProfileId: owner.ownerProfileId,
    ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
  });
  h.repos.episodes.appendTrace(episodeId as EpisodeId, [traceId]);

  const policy = policyRow({
    id: opts.id as PolicyRow["id"],
    status: opts.status ?? "candidate",
    support: opts.support ?? 0,
    gain: opts.gain ?? 0,
    gainVersion: opts.gainVersion ?? 1,
    sourceTraceIds: [traceId],
    ownerAgentKind: owner.ownerAgentKind,
    ownerProfileId: owner.ownerProfileId,
    ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
  });
  h.repos.policies.insert(policy);
  if (opts.linkEvidence !== false) {
    h.repos.tracePolicyLinks.link({
      traceId: traceId as TraceId,
      policyId: opts.id as PolicyId,
      episodeId: episodeId as EpisodeId,
      now: NOW,
    });
  }

  if (opts.blocked) {
    h.repos.gainRepair.upsertBlocked({
      policyId: opts.id as PolicyId,
      ownerAgentKind: owner.ownerAgentKind,
      ownerProfileId: owner.ownerProfileId,
      ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
      reason: opts.reason ?? "inferred_evidence_updated",
      blockedReason: "no_resolved_with",
      inferenceVersion: GAIN_INFERENCE_VERSION,
      now: NOW,
    });
  } else {
    h.repos.gainRepair.upsertPending({
      policyId: opts.id as PolicyId,
      ownerAgentKind: owner.ownerAgentKind,
      ownerProfileId: owner.ownerProfileId,
      ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
      reason: opts.reason ?? "inferred_evidence_updated",
      inferenceVersion: GAIN_INFERENCE_VERSION,
      now: NOW,
    });
  }
  return policy;
}

function deps(h: TmpDbHandle, config: L2Config, extra: Partial<GainRepairAttemptDeps> = {}): GainRepairAttemptDeps {
  return {
    db: h.db,
    repos: h.repos,
    config,
    owner: OWNER,
    thresholds: THRESHOLDS,
    log: rootLogger.child({ channel: "test.gain_repair" }),
    now: () => NOW,
    inferenceVersion: GAIN_INFERENCE_VERSION,
    ...extra,
  };
}

/**
 * Pre-mark the re-screen generation as consumed so a tick's rescreen step
 * does not re-run the evidence-union queue rebuild (which pre-blocks zero-resolved
 * policies and would mask engine-level outcome accounting). The engine's own
 * re-screen behavior is tested in the dedicated describe block.
 */
function preConsumeRescreen(h: TmpDbHandle): void {
  h.repos.kv.set(gainRepairRescreenKey(OWNER), {
    generation: 0,
    inferenceVersion: GAIN_INFERENCE_VERSION,
    consumedAt: NOW,
  });
}

describe("memory/l2/gain-repair — durable budget + tick", () => {
  beforeEach(() => {
    handle = makeTmpDb();
    preConsumeRescreen(handle);
  });
  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  it("first tick attempts exactly 25 of 30 pending (batch 25 / maxTotal 25); second tick and restart attempt zero; raise to 30 → exactly 5", () => {
    for (let i = 0; i < 30; i++) {
      seedPolicy({
        id: `po_${String(i).padStart(2, "0")}`,
        status: i < 20 ? "candidate" : "active",
        support: i < 20 ? 0 : 3,
        gainVersion: i < 20 ? 1 : 1,
      });
    }
    const cfg = baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 25 });
    const result = runGainRepairTick(deps(handle!, cfg));
    expect(result.attempted).toBe(25);
    expect(result.budget.attempted).toBe(25);
    expect(result.budget.remaining).toBe(0);

    // Second tick (same process) — ceiling reached.
    const second = runGainRepairTick(deps(handle!, cfg));
    expect(second.attempted).toBe(0);

    // "Restart" — a fresh engine over the same DB sees the same budget.
    const restart = runGainRepairTick(deps(handle!, cfg));
    expect(restart.attempted).toBe(0);
    expect(restart.budget.attempted).toBe(25);

    // Raise the ceiling to 30 → exactly 5 more.
    const raised = runGainRepairTick(
      deps(handle!, baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 30 })),
    );
    expect(raised.attempted).toBe(5);
    expect(raised.budget.attempted).toBe(30);
    expect(raised.budget.remaining).toBe(0);
  });

  it("null ceiling is unlimited and never resets the counter", () => {
    for (let i = 0; i < 30; i++) {
      seedPolicy({ id: `po_${String(i).padStart(2, "0")}` });
    }
    const cfg = baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: null });
    const first = runGainRepairTick(deps(handle!, cfg));
    expect(first.attempted).toBe(25);
    const second = runGainRepairTick(deps(handle!, cfg));
    expect(second.attempted).toBe(5);
    expect(second.budget.attempted).toBe(30);
    expect(second.budget.remaining).toBeNull();
  });

  it("lowering maxTotal below attempted pauses new attempts without resetting", () => {
    for (let i = 0; i < 5; i++) seedPolicy({ id: `po_${i}` });
    runGainRepairTick(deps(handle!, baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 5 })));
    // Lower the ceiling below attempted → paused.
    const paused = runGainRepairTick(
      deps(handle!, baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 3 })),
    );
    expect(paused.attempted).toBe(0);
    expect(paused.budget.remaining).toBe(0);
    // Raise again → resumes from the preserved counter (2 more = ceiling 5).
    const resumed = runGainRepairTick(
      deps(handle!, baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 5 })),
    );
    expect(resumed.budget.attempted).toBe(5);
    expect(resumed.attempted).toBe(0); // nothing left pending
  });

  it("batch size 0 pauses repair (tick does nothing) and re-enable resumes with preserved budget", () => {
    for (let i = 0; i < 5; i++) seedPolicy({ id: `po_${i}` });
    const paused = runGainRepairTick(deps(handle!, baseConfig({ gainRepairBatchSize: 0 })));
    expect(paused.attempted).toBe(0);
    expect(readGainRepairBudget(handle!.repos.kv, OWNER, null).initialized).toBe(false);

    const enabled = runGainRepairTick(
      deps(handle!, baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 10 })),
    );
    expect(enabled.attempted).toBe(5);
    // Pause again → no new attempts; budget preserved.
    const repause = runGainRepairTick(deps(handle!, baseConfig({ gainRepairBatchSize: 0 })));
    expect(repause.attempted).toBe(0);
    expect(readGainRepairBudget(handle!.repos.kv, OWNER, null).attempted).toBe(5);
  });

  it("v2 disabled means repair is not permitted (tick does nothing, no budget init)", () => {
    for (let i = 0; i < 3; i++) seedPolicy({ id: `po_${i}` });
    const cfg = baseConfig({ gainV2Enabled: false, gainRepairBatchSize: 25 });
    const result = runGainRepairTick(deps(handle!, cfg));
    expect(result.attempted).toBe(0);
    expect(readGainRepairBudget(handle!.repos.kv, OWNER, null).initialized).toBe(false);
  });

  it("blocked (no resolved with-evidence) and conflicted attempts consume budget", () => {
    // po_noev: queued pending with an unresolved evidence trace (NULL gainValue).
    seedPolicy({
      id: "po_noev",
      status: "candidate",
      support: 0,
      gainVersion: 1,
      gainValue: null,
    });
    // po_ok: repairable.
    seedPolicy({ id: "po_ok", status: "candidate" });

    const result = runGainRepairTick(
      deps(handle!, baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 10 })),
    );
    expect(result.attempted).toBe(2);
    expect(result.blocked).toBe(1);
    expect(result.rescored).toBe(1);
    expect(result.budget.attempted).toBe(2);

    const noev = handle!.repos.gainRepair.getByPolicy("po_noev" as PolicyId);
    expect(noev?.state).toBe("blocked");
    expect(noev?.blockedReason).toBe("no_resolved_with");
    // Policy fields untouched.
    const pol = handle!.repos.policies.getById("po_noev" as PolicyId);
    expect(pol?.gain).toBe(0);
    expect(pol?.gainVersion).toBe(1);
    expect(pol?.status).toBe("candidate");
  });

  it("unknown-owner entries are blocked and never mutated", () => {
    seedPolicy({ id: "po_unk", status: "candidate", support: 2, gainVersion: 1 });
    const h = handle!;
    const policy = h.repos.policies.getById("po_unk" as PolicyId);
    // Force unknown ownership on the policy (NULL/'unknown' → skipReason
    // unknown_owner in the shared selector) and re-queue it under the
    // 'unknown' owner namespace (the seed entry carried the openclaw owner).
    h.db.prepare<{ id: string }>(
      `UPDATE policies SET owner_agent_kind='unknown' WHERE id=@id`,
    ).run({ id: "po_unk" });
    h.repos.gainRepair.removeByPolicy("po_unk" as PolicyId);
    h.repos.gainRepair.upsertPending({
      policyId: "po_unk" as PolicyId,
      ownerAgentKind: "unknown",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      reason: "inferred_evidence_updated",
      inferenceVersion: GAIN_INFERENCE_VERSION,
      now: NOW,
    });
    // Pre-consume rescreen for the 'unknown' namespace so the evidence-union
    // rebuild does not pre-block this entry (its openclaw-owned evidence is
    // correctly out-of-namespace) — we are exercising the ENGINE's
    // unknown_owner skip path, not the bootstrap reconcile.
    h.repos.kv.set(gainRepairRescreenKey({ ownerAgentKind: "unknown", ownerProfileId: "default", ownerWorkspaceId: null }), {
      generation: 0,
      inferenceVersion: GAIN_INFERENCE_VERSION,
      consumedAt: NOW,
    });
    const cfg = baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 10 });
    const result = runGainRepairTick(
      deps(h, cfg, { owner: { ownerAgentKind: "unknown", ownerProfileId: "default", ownerWorkspaceId: null } }),
    );
    expect(result.attempted).toBe(1);
    expect(result.blocked).toBe(1);
    const entry = h.repos.gainRepair.getByPolicy("po_unk" as PolicyId);
    expect(entry?.state).toBe("blocked");
    expect(entry?.blockedReason).toBe("unknown_owner");
    const untouched = h.repos.policies.getById("po_unk" as PolicyId);
    expect(untouched?.gain).toBe(policy?.gain);
    expect(untouched?.gainVersion).toBe(1);
    expect(untouched?.status).toBe("candidate");
  });

  it("valid candidate promotes only when live thresholds qualify (raw first-v2 gain, support unchanged)", () => {
    // High gainValue 0.6 → gain 0.1 ≥ 0.04, support 2 → promote.
    seedPolicy({ id: "po_promote", status: "candidate", support: 2, gainVersion: 1, gainValue: 0.6 });
    // Low gainValue 0.4 → gain 0.0 < 0.04 → stays candidate.
    seedPolicy({ id: "po_stay", status: "candidate", support: 2, gainVersion: 1, gainValue: 0.4 });
    const result = runGainRepairTick(deps(handle!, baseConfig({ gainRepairBatchSize: 25 })));
    expect(result.promoted).toBe(1);
    expect(result.rescored).toBe(2);
    const promoted = handle!.repos.policies.getById("po_promote" as PolicyId);
    expect(promoted?.status).toBe("active");
    expect(promoted?.gainVersion).toBe(2);
    expect(promoted?.support).toBe(2); // support unchanged
    expect(promoted?.gain).toBeGreaterThanOrEqual(0.04);
    const stay = handle!.repos.policies.getById("po_stay" as PolicyId);
    expect(stay?.status).toBe("candidate");
    expect(stay?.gainVersion).toBe(2);
    // Queue entries resolved.
    expect(handle!.repos.gainRepair.getByPolicy("po_promote" as PolicyId)).toBeNull();
    expect(handle!.repos.gainRepair.getByPolicy("po_stay" as PolicyId)).toBeNull();
  });

  it("valid active refreshes gain/version but never archives even below the archive threshold", () => {
    // Active policy with negative computed gain (gainValue -0.1) — far below
    // archiveGain -0.05 — must stay active.
    seedPolicy({
      id: "po_active",
      status: "active",
      support: 3,
      gain: 0.2,
      gainVersion: 1,
      gainValue: -0.1,
    });
    const result = runGainRepairTick(deps(handle!, baseConfig({ gainRepairBatchSize: 25 })));
    expect(result.rescored).toBe(1);
    const pol = handle!.repos.policies.getById("po_active" as PolicyId);
    expect(pol?.status).toBe("active"); // NEVER archived
    expect(pol?.gainVersion).toBe(2);
    expect(pol?.support).toBe(3);
  });

  it("failed attempts (unexpected item failure) consume budget and continue; earlier commits preserved", () => {
    // po_a fails via the injected recompute seam; po_b commits normally AFTER.
    seedPolicy({ id: "po_a", status: "candidate", support: 2, gainVersion: 1 });
    seedPolicy({ id: "po_b", status: "candidate", support: 2, gainVersion: 1 });
    const wrapped = ((input: Parameters<typeof realRecompute>[0], d: Parameters<typeof realRecompute>[1]) => {
      if (input.policy.id === "po_a") throw new Error("boom");
      return realRecompute(input, d);
    }) as typeof realRecompute;

    const result = runGainRepairTick(
      deps(handle!, baseConfig({ gainRepairBatchSize: 25 }), { recomputePolicyGainFn: wrapped }),
    );
    expect(result.failed).toBe(1);
    expect(result.rescored).toBe(1);
    expect(result.attempted).toBe(2);
    expect(result.budget.attempted).toBe(2);
    // po_a reset to pending (retry later), journal marked failed.
    const entryA = handle!.repos.gainRepair.getByPolicy("po_a" as PolicyId);
    expect(entryA?.state).toBe("pending");
    // po_b committed normally.
    const polB = handle!.repos.policies.getById("po_b" as PolicyId);
    expect(polB?.gainVersion).toBe(2);
  });

  it("interrupted-claim reconcile resets claims without replay; retry is a NEW budgeted attempt", () => {
    seedPolicy({ id: "po_x", status: "candidate", support: 2, gainVersion: 1 });
    // Simulate a crash after reservation: budget consumed, entry claimed,
    // journal pending, but no policy write ever happened.
    const cfg = baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 10 });
    const reserved = reserveGainRepairAttempt(deps(handle!, cfg), "po_x" as PolicyId, "gr_crash1");
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") throw new Error("unreachable");
    const before = handle!.repos.policies.getById("po_x" as PolicyId);
    expect(before?.gainVersion).toBe(1); // nothing applied

    // Next tick reconciles the interrupted claim then retries.
    const result = runGainRepairTick(deps(handle!, cfg));
    expect(result.reconciled).toBeGreaterThanOrEqual(1); // the claim reset
    expect(result.attempted).toBe(1); // fresh budgeted attempt
    expect(result.budget.attempted).toBe(2); // reservation + retry both consumed
    const after = handle!.repos.policies.getById("po_x" as PolicyId);
    expect(after?.gainVersion).toBe(2); // repaired exactly once
    expect(handle!.repos.gainRepair.getByPolicy("po_x" as PolicyId)).toBeNull();

    // The interrupted journal row is marked failed; the retry is completed.
    const journal = handle!.db
      .prepare<unknown, { id: string; result: string }>(
        `SELECT id, result FROM gain_repair_journal WHERE policy_id='po_x' ORDER BY created_at`,
      )
      .all();
    expect(journal).toHaveLength(2);
    expect(journal[0]!.result).toBe("failed");
    expect(journal[1]!.result).toBe("completed");
  });

  it("natural-touch reconciliation removes already-v2 rows WITHOUT recompute, budget or duplicate EMA", () => {
    seedPolicy({
      id: "po_nat",
      status: "candidate",
      support: 3,
      gain: 0.123,
      gainVersion: 2,
      gainValue: 0.9,
    });
    const result = runGainRepairTick(deps(handle!, baseConfig({ gainRepairBatchSize: 25 })));
    expect(result.reconciled).toBe(1);
    expect(result.attempted).toBe(0);
    expect(result.budget.attempted).toBe(0);
    const pol = handle!.repos.policies.getById("po_nat" as PolicyId);
    expect(pol?.gain).toBe(0.123); // NO duplicate EMA
    expect(pol?.gainVersion).toBe(2);
    expect(handle!.repos.gainRepair.getByPolicy("po_nat" as PolicyId)).toBeNull();
  });

  it("inference-refresh-marked entries MUST recompute and resolve on success (never natural-reconciled)", () => {
    seedPolicy({
      id: "po_refresh",
      status: "candidate",
      support: 3,
      gain: 0.2,
      gainVersion: 2,
      gainValue: 0.6,
      reason: "inference_refresh",
    });
    const result = runGainRepairTick(deps(handle!, baseConfig({ gainRepairBatchSize: 25 })));
    expect(result.attempted).toBe(1);
    expect(result.reconciled).toBe(0);
    expect(result.rescored).toBe(1);
    const pol = handle!.repos.policies.getById("po_refresh" as PolicyId);
    expect(pol?.gainVersion).toBe(2);
    // Refresh recomputes with a reset EMA (raw gain), so it does NOT blend
    // the superseded 0.2 — the persisted gain is the fresh calculation.
    expect(pol?.gain).toBeGreaterThan(0.04);
    expect(handle!.repos.gainRepair.getByPolicy("po_refresh" as PolicyId)).toBeNull();
  });

  it("ordinary L2 updates/promotions never consume the repair budget", () => {
    seedPolicy({ id: "po_l2", status: "candidate", support: 1, gainVersion: 1 });
    // Ordinary L2 would update the policy directly (updateStats) — no queue
    // involvement, no budget.
    handle!.repos.policies.updateStats("po_l2" as PolicyId, {
      support: 3,
      gain: 0.3,
      gainVersion: 2,
      status: "active",
      updatedAt: NOW + 1,
    });
    const budget = readGainRepairBudget(handle!.repos.kv, OWNER, null);
    expect(budget.attempted).toBe(0);
    expect(budget.initialized).toBe(false);
    // The ordinary update also leaves the (stale) queue entry; the next tick
    // reconciles it as naturally repaired WITHOUT budget.
    const result = runGainRepairTick(deps(handle!, baseConfig({ gainRepairBatchSize: 25 })));
    expect(result.attempted).toBe(0);
    expect(result.reconciled).toBe(1);
    expect(handle!.repos.gainRepair.getByPolicy("po_l2" as PolicyId)).toBeNull();
  });

  it("namespace separation: same profile, different workspace — ticks never cross namespaces", () => {
    const ownerA: GainRepairOwner = { ...OWNER };
    const ownerB: GainRepairOwner = { ...OWNER, ownerWorkspaceId: "ws_b" };
    seedPolicy({ id: "po_a", owner: { ownerWorkspaceId: null } });
    seedPolicy({ id: "po_b", owner: { ownerWorkspaceId: "ws_b" } });

    const cfg = baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 5 });
    const resultA = runGainRepairTick(deps(handle!, cfg, { owner: ownerA }));
    expect(resultA.attempted).toBe(1);
    expect(handle!.repos.gainRepair.getByPolicy("po_b" as PolicyId)?.state).toBe("pending");

    const resultB = runGainRepairTick(deps(handle!, cfg, { owner: ownerB }));
    expect(resultB.attempted).toBe(1);
    // Separate budget counters per exact namespace.
    expect(readGainRepairBudget(handle!.repos.kv, ownerA, null).attempted).toBe(1);
    expect(readGainRepairBudget(handle!.repos.kv, ownerB, null).attempted).toBe(1);
  });

  it("candidate-first, stable ID order", () => {
    for (let i = 0; i < 4; i++) {
      seedPolicy({
        id: `po_${i}`,
        status: i % 2 === 0 ? "active" : "candidate",
        support: i % 2 === 0 ? 3 : 0,
      });
    }
    const cfg = baseConfig({ gainRepairBatchSize: 25 });
    // Force all four to be selected: candidates po_1, po_3 then active po_0, po_2.
    const journalPolicyIds = handle!.db
      .prepare<unknown, { policy_id: string }>(`SELECT policy_id FROM gain_repair_journal ORDER BY created_at`)
      .all()
      .map((r) => r.policy_id);
    // Nothing journaled yet (selection happens inside the tick). Verify order
    // via the tick result + journal insert order instead.
    const result = runGainRepairTick(deps(handle!, cfg));
    expect(result.attempted).toBe(4);
    const order = handle!.db
      .prepare<unknown, { policy_id: string }>(`SELECT policy_id FROM gain_repair_journal ORDER BY created_at`)
      .all()
      .map((r) => r.policy_id);
    expect(order).toEqual(["po_1", "po_3", "po_0", "po_2"]);
  });
});

describe("memory/l2/gain-repair — reservation races + conflict", () => {
  beforeEach(() => {
    handle = makeTmpDb();
    preConsumeRescreen(handle);
  });
  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  it("a second reservation for an already-claimed entry is skipped without consuming budget", () => {
    seedPolicy({ id: "po_r", status: "candidate", support: 2, gainVersion: 1 });
    const cfg = baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 5 });
    const first = reserveGainRepairAttempt(deps(handle!, cfg), "po_r" as PolicyId, "gr_1");
    expect(first.kind).toBe("reserved");
    // A racing writer claims the same entry (it is already claimed).
    const second = reserveGainRepairAttempt(deps(handle!, cfg), "po_r" as PolicyId, "gr_2");
    expect(second.kind).toBe("not_pending");
    expect(readGainRepairBudget(handle!.repos.kv, OWNER, null).attempted).toBe(1);
  });

  it("reservation refuses when the absolute ceiling is exhausted (tick stops)", () => {
    seedPolicy({ id: "po_r", status: "candidate", support: 2, gainVersion: 1 });
    handle!.repos.kv.set(gainRepairBudgetKey(OWNER), { attempted: 5, initializedAt: NOW });
    const cfg = baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 5 });
    const reserved = reserveGainRepairAttempt(deps(handle!, cfg), "po_r" as PolicyId, "gr_1");
    expect(reserved.kind).toBe("budget_exhausted");
    expect(readGainRepairBudget(handle!.repos.kv, OWNER, null).attempted).toBe(5);
  });

  it("concurrent policy change → journal conflict, entry left pending, never overwritten", () => {
    seedPolicy({ id: "po_c", status: "candidate", support: 2, gainVersion: 1 });
    const cfg = baseConfig({ gainRepairBatchSize: 25 });
    const reserved = reserveGainRepairAttempt(deps(handle!, cfg), "po_c" as PolicyId, "gr_1");
    if (reserved.kind !== "reserved") throw new Error("unreachable");
    // Ordinary L2 changes the policy between reservation and apply.
    handle!.repos.policies.updateStats("po_c" as PolicyId, {
      support: 4,
      gain: 0.44,
      gainVersion: 2,
      status: "active",
      updatedAt: NOW + 500,
    });
    const outcome = applyGainRepairAttempt(deps(handle!, cfg), "po_c" as PolicyId, reserved);
    expect(outcome.kind).toBe("conflicted");
    const pol = handle!.repos.policies.getById("po_c" as PolicyId);
    expect(pol?.gain).toBe(0.44); // NOT overwritten
    expect(pol?.support).toBe(4);
    expect(pol?.status).toBe("active");
    expect(handle!.repos.gainRepair.getByPolicy("po_c" as PolicyId)?.state).toBe("pending");
    const journal = handle!.db
      .prepare<unknown, { result: string }>(
        `SELECT result FROM gain_repair_journal WHERE policy_id='po_c' ORDER BY created_at DESC LIMIT 1`,
      )
      .get();
    expect(journal?.result).toBe("conflicted");
  });
});

describe("memory/l2/gain-repair — config-generation re-screen", () => {
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  it("consume-once per generation increase: requeues eligible blocked, never resets budget, never writes policy fields", () => {
    // po_b is blocked (its evidence is currently unresolved).
    seedPolicy({ id: "po_b", gainValue: null, blocked: true });
    const cfg = baseConfig({ gainRepairBatchSize: 25, gainRepairRescreenGeneration: 2 });
    const first = runGainRepairTick(deps(handle!, cfg));
    expect(first.rescreenConsumed).toBe(true);
    // Still blocked (evidence still unresolved) — not requeued.
    expect(handle!.repos.gainRepair.getByPolicy("po_b" as PolicyId)?.state).toBe("blocked");
    // No budget consumed by re-screen.
    expect(readGainRepairBudget(handle!.repos.kv, OWNER, null).attempted).toBe(0);

    // Same generation again → NOT consumed twice.
    const second = runGainRepairTick(deps(handle!, cfg));
    expect(second.rescreenConsumed).toBe(false);

    // Now the evidence becomes resolved (integrity correction), and a NEW
    // generation is requested → requeued and repaired.
    handle!.repos.traces.updateScore("tr_po_b" as TraceId, {
      value: 0.6,
      alpha: 0.5,
      priority: 0,
      gainValue: 0.6,
      gainValueSource: "live_normalized",
    });
    const cfg3 = baseConfig({ gainRepairBatchSize: 25, gainRepairRescreenGeneration: 3 });
    const third = runGainRepairTick(deps(handle!, cfg3));
    expect(third.rescreenConsumed).toBe(true);
    expect(third.blocked).toBe(0);
    expect(third.attempted).toBe(1); // requeued + attempted this tick
    expect(handle!.repos.gainRepair.getByPolicy("po_b" as PolicyId)).toBeNull();
    // Policy fields were only written by the repair attempt, never by the
    // re-screen itself; and the budget counter was never reset.
    expect(readGainRepairBudget(handle!.repos.kv, OWNER, null).attempted).toBe(1);
  });

  it("a new GAIN_INFERENCE_VERSION triggers the versioned re-screen", () => {
    seedPolicy({ id: "po_v", gainValue: 0.2, blocked: true });
    const cfg = baseConfig({ gainRepairBatchSize: 25, gainRepairRescreenGeneration: 0 });
    const first = runGainRepairTick(deps(handle!, cfg));
    expect(first.rescreenConsumed).toBe(true); // version bump vs stored (absent)

    // No further triggers.
    const second = runGainRepairTick(deps(handle!, cfg));
    expect(second.rescreenConsumed).toBe(false);

    // Simulate a future GAIN_INFERENCE_VERSION.
    const bumped = runGainRepairTick(
      deps(handle!, cfg, { inferenceVersion: GAIN_INFERENCE_VERSION + 1 }),
    );
    expect(bumped.rescreenConsumed).toBe(true);
  });

  it("re-screen never changes policy gain/status (queue-only)", () => {
    seedPolicy({ id: "po_bs", gainValue: null, blocked: true, gain: 0.05 });
    const cfg = baseConfig({ gainRepairBatchSize: 25, gainRepairRescreenGeneration: 1 });
    const result = consumeGainRepairRescreen(deps(handle!, cfg));
    expect(result.consumed).toBe(true);
    const pol = handle!.repos.policies.getById("po_bs" as PolicyId);
    expect(pol?.gain).toBe(0.05);
    expect(pol?.status).toBe("candidate");
    expect(pol?.gainVersion).toBe(1);
  });

  it("re-screen is a blocked-input repair, NOT a queue rebuild: completed policies are not re-seeded", () => {
    seedPolicy({ id: "po_done", status: "candidate", support: 2, gainVersion: 1 });
    // Repair it — the queue entry resolves (removed).
    runGainRepairTick(deps(handle!, baseConfig({ gainRepairBatchSize: 25 })));
    expect(handle!.repos.gainRepair.getByPolicy("po_done" as PolicyId)).toBeNull();

    // A generation increase must requeue ELIGIBLE BLOCKED records only — it
    // must not re-add the completed policy (that would re-process unchanged
    // evidence and let the queue lie about pending work).
    const attemptedBefore = readGainRepairBudget(handle!.repos.kv, OWNER, null).attempted;
    const res = consumeGainRepairRescreen(
      deps(handle!, baseConfig({ gainRepairRescreenGeneration: 3 })),
    );
    expect(res.consumed).toBe(true);
    expect(res.requeued).toBe(0);
    expect(handle!.repos.gainRepair.getByPolicy("po_done" as PolicyId)).toBeNull();
    // Budget untouched by the re-screen (counter preserved, never reset).
    expect(readGainRepairBudget(handle!.repos.kv, OWNER, null).attempted).toBe(attemptedBefore);
  });

  it("interrupted-claim reconcile runs BEFORE the re-screen: the orphaned journal row is closed, not left pending", () => {
    seedPolicy({ id: "po_crash", status: "candidate", support: 2, gainVersion: 1 });
    // Simulate a crash after reservation: budget consumed, entry claimed,
    // journal row still `pending`.
    const cfg = baseConfig({ gainRepairBatchSize: 25, gainRepairMaxTotal: 10, gainRepairRescreenGeneration: 1 });
    const reserved = reserveGainRepairAttempt(deps(handle!, cfg), "po_crash" as PolicyId, "gr_crash_rs");
    expect(reserved.kind).toBe("reserved");

    // The next tick reconciles the claim first (closing the orphaned journal
    // row) even though a re-screen generation is also pending, then retries.
    const result = runGainRepairTick(deps(handle!, cfg));
    expect(result.reconciled).toBeGreaterThanOrEqual(1);
    const orphan = handle!.db
      .prepare<unknown, { n: number }>(
        `SELECT COUNT(*) AS n FROM gain_repair_journal WHERE batch_id='gr_crash_rs' AND result='pending'`,
      )
      .get();
    expect(orphan?.n).toBe(0);
    // The retry completed in the same tick.
    expect(handle!.repos.policies.getById("po_crash" as PolicyId)?.gainVersion).toBe(2);
  });

  it("unknown_owner blocked entries are neither un-stamped nor requeued by a re-screen", () => {
    seedPolicy({ id: "po_unk2", status: "candidate", support: 2, gainVersion: 1 });
    const h = handle!;
    h.db.prepare<{ id: string }>(
      `UPDATE policies SET owner_agent_kind='unknown' WHERE id=@id`,
    ).run({ id: "po_unk2" });
    h.repos.gainRepair.removeByPolicy("po_unk2" as PolicyId);
    h.repos.gainRepair.upsertBlocked({
      policyId: "po_unk2" as PolicyId,
      ownerAgentKind: "unknown",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      reason: "inferred_evidence_updated",
      blockedReason: "unknown_owner",
      inferenceVersion: GAIN_INFERENCE_VERSION,
      now: NOW,
    });
    const traceBefore = h.repos.traces.getById("tr_po_unk2" as TraceId);
    const res = consumeGainRepairRescreen(deps(h, baseConfig({ gainRepairRescreenGeneration: 5 })));
    expect(res.consumed).toBe(true);
    expect(res.requeued).toBe(0);
    const entry = h.repos.gainRepair.getByPolicy("po_unk2" as PolicyId);
    expect(entry?.state).toBe("blocked");
    expect(entry?.blockedReason).toBe("unknown_owner");
    // Owner-integrity blocks are not evidence-integrity: the trace stamp is
    // left untouched (still the resolved score it had before).
    const traceAfter = h.repos.traces.getById("tr_po_unk2" as TraceId);
    expect(traceAfter?.gainValue).toBe(traceBefore?.gainValue);
    expect(traceAfter?.gainValueSource).toBe(traceBefore?.gainValueSource);
  });
});
