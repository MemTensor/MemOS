/**
 * `gain-repair.ts` — per-policy attempt engine.
 *
 * Used ONLY by the repair timer (core/pipeline/memory-core.ts); ordinary L2,
 * preview and rollback never call it. The engine owns the durable total-attempt
 * budget (kv, `pipeline.<name>.v1` — no separate budget table), the per-policy
 * reservation + recompute transactions, the interrupted-claim reconcile and the
 * config-generation re-screen. Policy field writes happen here (under a short
 * per-policy transaction) — that is the timer exception to the
 * "transaction layer owns policy writes" rule, because the timer has no other
 * transaction layer of its own.
 *
 * Atomicity contract:
 *
 *   • Reservation (one tx): read budget from kv, refuse when the absolute
 *     ceiling is exhausted, claim the queue entry, increment the budget and
 *     journal an attempt/claim (`result='pending'`) — ALL before any repair
 *     work. A crash after reservation consumes that attempt; the next tick's
 *     interrupted-claim reconcile resets the queue entry to `pending` and marks
 *     the orphaned journal row `failed` WITHOUT replaying a committed repair.
 *     Any retry is a new budgeted attempt.
 *
 *   • Per-policy transaction (one tx): re-read the policy + evidence fresh
 *     (no review-token/fingerprint scheme), detect concurrent policy changes
 *     (journal `conflicted`, leave pending, never overwrite), recompute gain
 * via the shared helper, then commit policy fields + final queue state
 *     + journal outcome together. `unknown_owner` / `no_resolved_with` become
 *     `blocked` (budget consumed, policy never mutated). Active policies never
 *     archive; support never increments; no LLM calls; no synthetic L2 events.
 *
 * Outcomes consume budget: blocked, conflicted and failed. Natural-touch
 * reconciliation (already-v2 / already-repaired rows) and ordinary L2
 * updates/promotions do NOT consume budget. Re-screen never consumes budget
 * and never writes policy fields.
 */

import { ids } from "../../id.js";
import type { Logger } from "../../logger/types.js";
import type { Repos } from "../../storage/repos/index.js";
import type { makeKvRepo } from "../../storage/repos/kv.js";
import type { StorageDb } from "../../storage/types.js";
import type { PolicyId, PolicyRow, RuntimeNamespace, TraceId } from "../../types.js";
import { GAIN_INFERENCE_VERSION, runGainInference } from "../../reward/gain-inference.js";
import type { GainRepairQueueRow } from "../../storage/repos/gain-repair.js";
import {
  isBorrowedEvidence,
  isResolvedGainValue,
  normalizeOwner,
  recomputePolicyGain,
  type RecomputeGainResult,
} from "./recompute-gain.js";
import type { L2Config } from "./types.js";

// ─── Durable budget (kv, namespace-prefixed, pipeline.<name>.v1) ─────────────

export const GAIN_REPAIR_BUDGET_KEY = "pipeline.gain_repair_budget.v1";
export const GAIN_REPAIR_RESCREEN_KEY = "pipeline.gain_repair_rescreen.v1";
export const GAIN_REPAIR_ALGORITHM_VERSION = "gain-repair.v1";

export interface GainRepairOwner {
  ownerAgentKind: string;
  ownerProfileId: string;
  ownerWorkspaceId?: string | null;
}

export interface GainRepairBudgetState {
  /** Attempts consumed since the first enabled campaign. Never reset/refunded. */
  attempted: number;
  /** Live absolute ceiling from config; null = unlimited. */
  limit: number | null;
  /** null when unlimited; otherwise max(0, limit − attempted). */
  remaining: number | null;
  /** False until the first enabled tick initializes the counter. */
  initialized: boolean;
}

/** Namespace-prefixed budget key — one counter per exact owner/namespace. */
export function gainRepairBudgetKey(owner: GainRepairOwner): string {
  return `${GAIN_REPAIR_BUDGET_KEY}.${owner.ownerAgentKind}.${owner.ownerProfileId}.${owner.ownerWorkspaceId ?? "default"}`;
}

export function gainRepairRescreenKey(owner: GainRepairOwner): string {
  return `${GAIN_REPAIR_RESCREEN_KEY}.${owner.ownerAgentKind}.${owner.ownerProfileId}.${owner.ownerWorkspaceId ?? "default"}`;
}

interface StoredBudget {
  attempted: number;
  initializedAt: number;
}

/**
 * Parse the persisted attempt counter. A present-but-malformed value (wrong
 * JSON shape, non-finite number, negative) is treated as CORRUPT, not as
 * zero: callers fail closed (no new attempts) so corrupt kv JSON can neither
 * reset the counter nor bypass the ceiling. The corrupt value itself is never
 * overwritten here — only an explicit operator clear removes it.
 */
function parseBudgetAttempted(stored: StoredBudget | null): number | null {
  if (!stored) return 0;
  const raw = (stored as { attempted?: unknown }).attempted;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.floor(raw);
}

export function readGainRepairBudget(
  kv: ReturnType<typeof makeKvRepo>,
  owner: GainRepairOwner,
  maxTotal: number | null,
): GainRepairBudgetState {
  const stored = kv.get<StoredBudget | null>(gainRepairBudgetKey(owner), null);
  const parsed = parseBudgetAttempted(stored);
  const attempted = parsed ?? 0;
  return {
    attempted,
    limit: maxTotal,
    // Corrupt counters report zero remaining (fail closed) rather than a
    // fresh allowance.
    remaining: maxTotal === null ? null : parsed === null ? 0 : Math.max(0, maxTotal - attempted),
    initialized: stored != null,
  };
}

// ─── Engine deps + result ────────────────────────────────────────────────────

export interface GainRepairAttemptDeps {
  db: StorageDb;
  repos: Pick<
    Repos,
    | "episodes"
    | "gainRepair"
    | "kv"
    | "policies"
    | "tracePolicyLinks"
    | "traces"
  >;
  /** Live config slice (extractAlgorithmConfig output) — re-read every tick. */
  config: L2Config;
  /** Exact namespace of the timer owner. */
  owner: GainRepairOwner;
  /** Live promotion thresholds (minSupport/minGain); archive is never used. */
  thresholds: { minSupport: number; minGain: number; archiveGain: number };
  log: Logger;
  now?: () => number;
  inferenceVersion?: number;
  /**
   * Test seam — the shared recompute core, injectable so unit tests can force
   * an unexpected item failure. Never wired from the timer.
   */
  recomputePolicyGainFn?: typeof recomputePolicyGain;
}

export interface GainRepairTickCounts {
  attempted: number;
  rescored: number;
  promoted: number;
  blocked: number;
  conflicted: number;
  failed: number;
  reconciled: number;
}

export interface GainRepairTickResult extends GainRepairTickCounts {
  batchId: string;
  budget: { attempted: number; limit: number | null; remaining: number | null };
  inferenceVersion: number;
  rescreenConsumed: boolean;
  durationMs: number;
}

export type GainRepairReservationOutcome =
  | { kind: "reserved"; journalId: string; policy: PolicyRow }
  | { kind: "budget_exhausted" }
  | { kind: "reconciled" }
  | { kind: "not_pending" };

export type GainRepairApplyOutcome =
  | { kind: "completed" }
  | { kind: "promoted" }
  | { kind: "blocked" }
  | { kind: "conflicted" }
  | { kind: "failed" }
  | { kind: "reconciled" };

// ─── Per-policy reservation (atomic: budget + claim + journal) ───────────────

/**
 * Atomically reserve one budget unit, claim the queue entry and journal an
 * attempt BEFORE any repair work. Returns `budget_exhausted` when the absolute
 * ceiling is reached (the tick must stop), `not_pending` when another writer
 * already claimed the entry (skip, no budget consumed), and `reconciled` when
 * the entry turned out to be naturally repaired / archived / missing (no
 * budget consumed, queue cleaned). If this transaction throws, the tick stops
 * before any repair work.
 */
export function reserveGainRepairAttempt(
  deps: GainRepairAttemptDeps,
  policyId: PolicyId,
  batchId: string,
): GainRepairReservationOutcome {
  const owner = deps.owner;
  const budgetKey = gainRepairBudgetKey(owner);
  const now = deps.now?.() ?? Date.now();
  return deps.db.tx(() => {
    const stored = deps.repos.kv.get<StoredBudget | null>(budgetKey, null);
    const attempted = parseBudgetAttempted(stored);
    if (attempted === null) {
      // Corrupt counter: fail closed (stop the tick) without writing — never
      // "repair" it into a fresh zero that would re-open spent budget.
      return { kind: "budget_exhausted" } as const;
    }
    const limit = deps.config.gainRepairMaxTotal;
    if (limit !== null && attempted >= limit) {
      return { kind: "budget_exhausted" } as const;
    }
    const entry = deps.repos.gainRepair.getByPolicy(policyId);
    if (!entry || entry.state !== "pending") {
      return { kind: "not_pending" } as const;
    }
    if (
      entry.ownerAgentKind !== owner.ownerAgentKind ||
      entry.ownerProfileId !== owner.ownerProfileId ||
      (entry.ownerWorkspaceId ?? null) !== (owner.ownerWorkspaceId ?? null)
    ) {
      // Defensive: queue selection is owner-scoped, but a tick must never
      // claim another namespace's entry even if selection ever widened. Skip
      // without consuming budget.
      return { kind: "not_pending" } as const;
    }
    const policy = deps.repos.policies.getById(policyId);
    if (!policy || policy.status === "archived") {
      // Archived/missing policies are never repair targets — reconcile away.
      deps.repos.gainRepair.removeByPolicy(policyId);
      return { kind: "reconciled" } as const;
    }
    if (isNaturallyRepaired(policy, entry)) {
      // Already v2-certified with live support and no inference invalidation:
      // reconcile WITHOUT recomputation — no duplicate EMA, no budget unit.
      deps.repos.gainRepair.removeByPolicy(policyId);
      return { kind: "reconciled" } as const;
    }
    // Reserve: budget + claim + journal in one transaction.
    deps.repos.kv.set(budgetKey, { attempted: attempted + 1, initializedAt: stored?.initializedAt ?? now });
    deps.repos.gainRepair.setQueueState(policyId, {
      state: "claimed",
      attemptCount: entry.attemptCount + 1,
      lastAttemptAt: now,
      lastAttemptBatchId: batchId,
      now,
    });
    const journalId = ids.uuid();
    deps.repos.gainRepair.insertJournal({
      id: journalId,
      batchId,
      ownerAgentKind: owner.ownerAgentKind,
      ownerProfileId: owner.ownerProfileId,
      ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
      policyId,
      oldGain: policy.gain,
      newGain: null,
      oldGainVersion: policy.gainVersion ?? 1,
      newGainVersion: null,
      oldStatus: policy.status,
      newStatus: null,
      oldSupport: policy.support,
      newSupport: null,
      algorithmVersion: GAIN_REPAIR_ALGORITHM_VERSION,
      configVersion: configVersionOf(deps.config),
      inferenceVersion: deps.inferenceVersion ?? GAIN_INFERENCE_VERSION,
      provenance: [],
      excludedWithCount: 0,
      excludedWithoutCount: 0,
      result: "pending",
      createdAt: now,
      // The post-write timestamp is unknown until the attempt commits; the
      // completing path records it via updateJournalOutcome (migration 19).
      newUpdatedAt: null,
    });
    return { kind: "reserved", journalId, policy } as const;
  });
}

// ─── Per-policy recompute + atomic commit ────────────────────────────────────

/**
 * Recompute the policy with FRESH rows and commit policy fields + final queue
 * state + journal outcome atomically. Every read (policy + evidence) happens
 * inside this transaction; there is no review-token/fingerprint scheme.
 *
 *   • concurrent policy change → journal `conflicted`, leave the entry
 *     `pending` for a later budgeted attempt, never overwrite;
 *   • `unknown_owner` / `no_resolved_with` → `blocked` with reason, budget
 *     already consumed, policy never mutated;
 *   • valid candidate → raw first-v2 gain, unchanged support, promote only if
 *     live thresholds qualify;
 *   • valid active → refresh gain/version, preserve `active` even below the
 *     archive threshold (timer repair NEVER archives);
 *   • inference-refresh-marked entries recompute (EMA reset) and on success
 *     the queue entry is removed;
 *   • a policy that became naturally repaired since reservation reconciles
 *     without a duplicate EMA.
 */
export function applyGainRepairAttempt(
  deps: GainRepairAttemptDeps,
  policyId: PolicyId,
  reservation: { journalId: string; policy: PolicyRow },
): GainRepairApplyOutcome {
  const owner = deps.owner;
  const now = deps.now?.() ?? Date.now();
  const recompute = deps.recomputePolicyGainFn ?? recomputePolicyGain;
  return deps.db.tx(() => {
    const policy = deps.repos.policies.getById(policyId);
    if (!policy) {
      // Deleted while reserved — reconcile away, close the journal as failed
      // (the attempt consumed its budget unit but wrote nothing).
      deps.repos.gainRepair.removeByPolicy(policyId);
      deps.repos.gainRepair.updateJournalOutcome(reservation.journalId, { result: "failed" });
      return { kind: "reconciled" } as const;
    }
    if (policyChanged(reservation.policy, policy)) {
      // Concurrent ordinary-L2 / manual change since reservation: never
      // overwrite. Leave the entry pending for a later budgeted attempt.
      deps.repos.gainRepair.setQueueState(policyId, { state: "pending", now });
      deps.repos.gainRepair.updateJournalOutcome(reservation.journalId, {
        newGain: policy.gain,
        newGainVersion: policy.gainVersion ?? 1,
        newStatus: policy.status,
        newSupport: policy.support,
        result: "conflicted",
      });
      return { kind: "conflicted" } as const;
    }
    const entry = deps.repos.gainRepair.getByPolicy(policyId);
    if (entry && isNaturallyRepaired(policy, entry)) {
      // Race guard: the policy became naturally repaired after reservation.
      // Reconcile without recomputation; no duplicate EMA. The reserved budget
      // unit is intentionally NOT refunded (reservation is a commitment).
      deps.repos.gainRepair.removeByPolicy(policyId);
      deps.repos.gainRepair.updateJournalOutcome(reservation.journalId, {
        newGain: policy.gain,
        newGainVersion: policy.gainVersion ?? 1,
        newStatus: policy.status,
        newSupport: policy.support,
        result: "completed",
      });
      return { kind: "reconciled" } as const;
    }

    const mode =
      entry?.reason === "inference_refresh" ? ("inference_refresh" as const) : ("repair" as const);
    const recomputed = recompute(
      {
        policy,
        namespace: namespaceFromOwner(owner),
        config: deps.config,
        mode,
      },
      {
        episodes: deps.repos.episodes,
        traces: deps.repos.traces,
        tracePolicyLinks: deps.repos.tracePolicyLinks,
      },
    );

    if (recomputed.skipReason !== null) {
      const blockedReason =
        recomputed.skipReason === "unknown_owner" ? "unknown_owner" : "no_resolved_with";
      // No resolved with-evidence / unknown owner: blocked, policy never
      // mutated. Budget already consumed (blocked outcomes consume budget).
      deps.repos.gainRepair.setQueueState(policyId, {
        state: "blocked",
        blockedReason,
        now,
      });
      deps.repos.gainRepair.updateJournalOutcome(reservation.journalId, {
        result: "blocked",
        excludedWithCount: recomputed.excluded.unresolvedWith,
        excludedWithoutCount: recomputed.excluded.unresolvedWithout,
      });
      return { kind: "blocked" } as const;
    }

    // Valid computation: support never increments; active never archives.
    const support = policy.support;
    let status: "candidate" | "active";
    if (policy.status === "active") {
      status = "active";
    } else {
      status =
        support >= deps.thresholds.minSupport && recomputed.persistedGain >= deps.thresholds.minGain
          ? "active"
          : "candidate";
    }
    deps.repos.policies.updateStats(policyId, {
      support,
      gain: recomputed.persistedGain,
      gainVersion: 2,
      status,
      updatedAt: now,
    });
    // Completed — final queue state is "removed" (the entry resolves).
    deps.repos.gainRepair.removeByPolicy(policyId);
    deps.repos.gainRepair.updateJournalOutcome(reservation.journalId, {
      newGain: recomputed.persistedGain,
      newGainVersion: 2,
      newStatus: status,
      newSupport: support,
      // Record the exact post-write timestamp (migration 19): the
      // five-field CAS in `policies.gainRollback` compares against it, so a
      // newer timestamp write after this commit is detectable.
      newUpdatedAt: now,
      provenance: provenanceStrings(recomputed),
      excludedWithCount: recomputed.excluded.unresolvedWith,
      excludedWithoutCount: recomputed.excluded.unresolvedWithout,
      result: "completed",
    });
    return { kind: policy.status === "candidate" && status === "active" ? "promoted" : "completed" } as const;
  });
}

// ─── Interrupted-claim reconcile ─────────────────────────────────────────────

/**
 * Restart reconciliation: every `claimed` queue entry is an interrupted
 * attempt (the per-policy transaction never committed — a committed repair
 * leaves a final state). Reset to `pending` so a LATER tick can retry as a NEW
 * budgeted attempt, and close the orphaned `pending` journal row as `failed`.
 * Never replays a committed repair and never refunds the reserved budget unit.
 */
export function reconcileInterruptedGainRepairClaims(deps: GainRepairAttemptDeps): number {
  return deps.db.tx(() => {
    const claimed = deps.repos.gainRepair.listByOwnerAndState(deps.owner, "claimed");
    for (const row of claimed) {
      deps.repos.gainRepair.setQueueState(row.policyId, { state: "pending" });
      if (row.lastAttemptBatchId) {
        deps.repos.gainRepair.markInterruptedJournal(row.policyId, row.lastAttemptBatchId);
      }
    }
    return claimed.length;
  });
}

// ─── Config-generation re-screen (kv, consume-once) ──────────────────────────

interface StoredRescreen {
  generation: number;
  inferenceVersion: number;
  consumedAt: number;
}

export interface GainRepairRescreenResult {
  consumed: boolean;
  requeued: number;
  inferenceVersion: number;
}

/**
 * Consume each `gainRepairRescreenGeneration` increase ONCE (and each new
 * GAIN_INFERENCE_VERSION): rerun historical screening for blocked inputs at
 * the current inference version, then requeue eligible blocked records.
 *
 *   • Only blocked entries whose `blockedReason` indicates an evidence-
 *     integrity correction (`no_resolved_with`) have their evidence un-stamped
 *     (live provenance never overwritten), so the idempotent pass revisits
 *     those groups — including already-inferred inputs. `unknown_owner` blocks
 *     are owner-integrity, not evidence-integrity: untouched and never
 *     requeued (auto-mutation cannot repair them).
 *   • The requeue is TARGETED: a blocked entry flips back to `pending` only
 *     when its with-evidence now holds ≥ 1 resolved, non-borrowed score under
 * the same predicate as the evidence union reconcile. Completed / reconciled
 *     policies are NOT re-seeded — a re-screen is a blocked-input repair, not
 *     a queue rebuild (a full rebuild would re-add every already-repaired
 *     policy and re-process unchanged evidence).
 *   • Never resets the budget, never writes policy gain/status, never
 *     consumes an attempt.
 */
export function consumeGainRepairRescreen(
  deps: GainRepairAttemptDeps,
): GainRepairRescreenResult {
  const version = deps.inferenceVersion ?? GAIN_INFERENCE_VERSION;
  const now = deps.now?.() ?? Date.now();
  const key = gainRepairRescreenKey(deps.owner);
  const stored = deps.repos.kv.get<StoredRescreen | null>(key, null);
  const gen = deps.config.gainRepairRescreenGeneration;
  const pendingGenIncrease = gen > (stored?.generation ?? 0);
  const pendingVersionBump = version > (stored?.inferenceVersion ?? 0);
  if (!pendingGenIncrease && !pendingVersionBump) {
    return { consumed: false, requeued: 0, inferenceVersion: version };
  }

  // 1. Un-stamp evidence-integrity blocked entries so the idempotent screening
  //    pass revisits their episode groups at the current version.
  const blocked = deps.repos.gainRepair.listBlockedByOwner(deps.owner);
  const evidenceIds = new Set<string>();
  const integrityBlocked: PolicyId[] = [];
  for (const row of blocked) {
    // Evidence-integrity blocks (`no_resolved_with`) AND rolled-back entries
    // resume through the same generation: a rollback parks the queue entry as
    // blocked with `rolled_back` and the next generation bump un-stamps its
    // evidence, re-screens it and requeues it when resolved. There is no
    // separate approval/requeue flow. `unknown_owner` blocks are
    // owner-integrity, not evidence-integrity: untouched and never requeued.
    if (row.blockedReason !== "no_resolved_with" && row.blockedReason !== "rolled_back") continue;
    const policy = deps.repos.policies.getById(row.policyId);
    if (!policy || policy.status === "archived") {
      // Missing / archived policies are never repair targets — reconcile the
      // stale entry away (queue-only).
      deps.repos.gainRepair.removeByPolicy(row.policyId);
      continue;
    }
    integrityBlocked.push(row.policyId);
    for (const id of deps.repos.tracePolicyLinks.getWithTraceIds(row.policyId)) {
      evidenceIds.add(String(id));
    }
    for (const id of policy.sourceTraceIds ?? []) evidenceIds.add(String(id));
  }
  const traceIds = Array.from(evidenceIds);
  if (traceIds.length > 0) {
    deps.db.tx(() => {
      for (const id of traceIds) {
        deps.repos.traces.unstampGainForRescreen(id as TraceId);
      }
    });
  }

  // 2. Idempotent historical screening at the current inference version.
  runGainInference({
    db: deps.db,
    kv: deps.repos.kv,
    episodesRepo: deps.repos.episodes,
    tracesRepo: deps.repos.traces,
    owner: deps.owner,
    inferenceVersion: version,
  });

  // 3. Requeue eligible blocked records (queue-only; never policy fields).
  let requeued = 0;
  deps.db.tx(() => {
    for (const policyId of integrityBlocked) {
      const policy = deps.repos.policies.getById(policyId);
      if (!policy || policy.status === "archived") continue;
      const withIdSet = new Set<string>([
        ...deps.repos.tracePolicyLinks.getWithTraceIds(policyId).map(String),
        ...(policy.sourceTraceIds ?? []).map(String),
      ]);
      if (withIdSet.size === 0) continue;
      const policyOwner = normalizeOwner(policy);
      let resolved = 0;
      for (const r of deps.repos.traces.getGainRowsByIds(Array.from(withIdSet))) {
        if (!isResolvedGainValue(r.gainValue)) continue;
        if (isBorrowedEvidence(policyOwner, r)) continue;
        resolved++;
      }
      if (resolved > 0) {
        // Preserves the entry's reason (incl. `inference_refresh`) and attempt
        // metadata — the queue state flips, nothing else.
        deps.repos.gainRepair.setQueueState(policyId, { state: "pending", now });
        requeued++;
      }
    }
    // 4. Record consumption in the same transaction as the requeue writes.
    deps.repos.kv.set(key, { generation: gen, inferenceVersion: version, consumedAt: now });
  });
  return { consumed: true, requeued, inferenceVersion: version };
}

// ─── Tick orchestrator (used ONLY by the timer) ──────────────────────────────

export function runGainRepairTick(deps: GainRepairAttemptDeps): GainRepairTickResult {
  const startedAt = Date.now();
  const batchId = `gr_${ids.span()}`;
  const version = deps.inferenceVersion ?? GAIN_INFERENCE_VERSION;
  const counts: GainRepairTickCounts = {
    attempted: 0,
    rescored: 0,
    promoted: 0,
    blocked: 0,
    conflicted: 0,
    failed: 0,
    reconciled: 0,
  };

  // Gate: batch size 0 pauses repair; v2 disabled means repair is not
  // permitted. A gated tick does nothing (including rescreen consumption).
  if (!deps.config.gainV2Enabled || deps.config.gainRepairBatchSize <= 0) {
    const budget = readGainRepairBudget(deps.repos.kv, deps.owner, deps.config.gainRepairMaxTotal);
    return {
      ...counts,
      batchId,
      budget,
      inferenceVersion: version,
      rescreenConsumed: false,
      durationMs: Date.now() - startedAt,
    };
  }

  // Restart reconcile FIRST: interrupted claims reset to pending (no replay,
  // no refund) and their orphaned journal rows closed as `failed`. This must
  // precede the re-screen so a rescreen can never overwrite a `claimed` entry
  // (queue upserts would flip it) without the journal ledger being closed.
  counts.reconciled += reconcileInterruptedGainRepairClaims(deps);

  // Re-screen generation: consume each increase once, before selection.
  const rescreen = consumeGainRepairRescreen(deps);

  // Budget: first enabled campaign initializes once per exact namespace.
  const budgetKey = gainRepairBudgetKey(deps.owner);
  deps.db.tx(() => {
    const stored = deps.repos.kv.get<StoredBudget | null>(budgetKey, null);
    if (!stored) {
      deps.repos.kv.set(budgetKey, { attempted: 0, initializedAt: deps.now?.() ?? Date.now() });
    }
  });
  const budgetState = readGainRepairBudget(
    deps.repos.kv,
    deps.owner,
    deps.config.gainRepairMaxTotal,
  );

  // Attempt at most min(batchSize, remainingBudget) per tick.
  const cap = Math.min(
    deps.config.gainRepairBatchSize,
    budgetState.remaining === null ? deps.config.gainRepairBatchSize : budgetState.remaining,
  );
  if (cap <= 0) {
    return {
      ...counts,
      batchId,
      budget: budgetState,
      inferenceVersion: version,
      rescreenConsumed: rescreen.consumed,
      durationMs: Date.now() - startedAt,
    };
  }

  // Exact-namespace candidate-first then active, stable ID order.
  const targets = deps.repos.gainRepair.listPendingForRepair(deps.owner, cap);
  for (const target of targets) {
    let reservation: GainRepairReservationOutcome;
    try {
      reservation = reserveGainRepairAttempt(deps, target.policyId, batchId);
    } catch (err) {
      // A reservation that cannot be persisted stops the tick before any
      // repair work — transaction state is unknown.
      deps.log.warn("gain_repair.reservation_failed", {
        batchId,
        policyId: target.policyId,
        err: err instanceof Error ? err.message : String(err),
      });
      break;
    }
    if (reservation.kind === "budget_exhausted") break;
    if (reservation.kind === "reconciled") {
      counts.reconciled += 1;
      continue;
    }
    if (reservation.kind === "not_pending") continue;

    counts.attempted += 1;
    let outcome: GainRepairApplyOutcome;
    try {
      outcome = applyGainRepairAttempt(deps, target.policyId, reservation);
    } catch (err) {
      // The per-policy transaction rolled back (no partial writes): earlier
      // commits are preserved, the reservation persists and the attempt is
      // consumed. Record failure + mark the claim failed so a later tick can
      // retry as a NEW budgeted attempt.
      deps.log.warn("gain_repair.attempt_failed", {
        batchId,
        policyId: target.policyId,
        err: err instanceof Error ? err.message : String(err),
      });
      try {
        deps.db.tx(() => {
          deps.repos.gainRepair.setQueueState(target.policyId, { state: "pending" });
          deps.repos.gainRepair.updateJournalOutcome(reservation.journalId, { result: "failed" });
        });
      } catch (recoverErr) {
        // Tx state unknown — stop the tick rather than risk double-apply.
        deps.log.warn("gain_repair.failure_recovery_failed", {
          batchId,
          policyId: target.policyId,
          err: recoverErr instanceof Error ? recoverErr.message : String(recoverErr),
        });
        break;
      }
      counts.failed += 1;
      continue;
    }
    switch (outcome.kind) {
      case "promoted":
        counts.promoted += 1;
        counts.rescored += 1;
        break;
      case "completed":
        counts.rescored += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "conflicted":
        counts.conflicted += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "reconciled":
        counts.reconciled += 1;
        break;
    }
  }

  const finalBudget = readGainRepairBudget(deps.repos.kv, deps.owner, deps.config.gainRepairMaxTotal);
  const result: GainRepairTickResult = {
    ...counts,
    batchId,
    budget: finalBudget,
    inferenceVersion: version,
    rescreenConsumed: rescreen.consumed,
    durationMs: Date.now() - startedAt,
  };
  deps.log.info("gain_repair.tick.done", {
    namespace: {
      ownerAgentKind: deps.owner.ownerAgentKind,
      ownerProfileId: deps.owner.ownerProfileId,
      ownerWorkspaceId: deps.owner.ownerWorkspaceId ?? null,
    },
    ...result,
    config: {
      gainV2Enabled: deps.config.gainV2Enabled,
      minGainValue: deps.config.minGainValue,
      gainRepairBatchSize: deps.config.gainRepairBatchSize,
      gainRepairMaxTotal: deps.config.gainRepairMaxTotal,
    },
    algorithmVersion: GAIN_REPAIR_ALGORITHM_VERSION,
    configVersion: configVersionOf(deps.config),
  });
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Already-v2 / naturally repaired: the policy carries a v2-certified gain with
 * live support and the queue entry was NOT explicitly invalidated by an
 * inference-rule/input refresh. Such entries reconcile without recomputation —
 * a repair recompute would re-EMA unchanged evidence (duplicate EMA). Entries
 * marked `inference_refresh` MUST recompute and only resolve on success.
 */
function isNaturallyRepaired(policy: PolicyRow, entry: GainRepairQueueRow | null): boolean {
  if (!entry) return false;
  if (entry.reason === "inference_refresh") return false;
  return (policy.gainVersion ?? 1) === 2 && policy.support > 0;
}

/**
 * Concurrent policy change guard (journal `conflicted`): any change to the
 * fields the timer would overwrite — status, support, gain, gain_version,
 * updated_at — since the reservation snapshot means the policy is being
 * touched elsewhere. Never overwrite; leave pending for a later budgeted
 * attempt.
 */
function policyChanged(before: PolicyRow, after: PolicyRow): boolean {
  return (
    before.status !== after.status ||
    before.support !== after.support ||
    before.gain !== after.gain ||
    (before.gainVersion ?? 1) !== (after.gainVersion ?? 1) ||
    before.updatedAt !== after.updatedAt
  );
}

export function namespaceFromOwner(owner: GainRepairOwner): RuntimeNamespace {
  return {
    agentKind: owner.ownerAgentKind as RuntimeNamespace["agentKind"],
    profileId: owner.ownerProfileId,
    ...(owner.ownerWorkspaceId ? { workspaceId: owner.ownerWorkspaceId } : {}),
  };
}

function provenanceStrings(recomputed: RecomputeGainResult): string[] {
  const out: string[] = [];
  if (recomputed.provenance.liveNormalized > 0) {
    out.push(`live_normalized:${recomputed.provenance.liveNormalized}`);
  }
  if (recomputed.provenance.inferredNormalized > 0) {
    out.push(`inferred_normalized:${recomputed.provenance.inferredNormalized}`);
  }
  if (recomputed.provenance.legacyUnscaled > 0) {
    out.push(`legacy_unscaled:${recomputed.provenance.legacyUnscaled}`);
  }
  return out;
}

/** Stable short config fingerprint for journal/audit (no secret material). */
export function configVersionOf(config: L2Config): string {
  const {
    gainEmaAlpha,
    gainV2Enabled,
    minGainValue,
    gainRepairBatchSize,
    gainRepairMaxTotal,
    gainRepairIntervalMs,
    gainRepairRescreenGeneration,
  } = config;
  return (
    `v2=${gainV2Enabled ? 1 : 0};ema=${gainEmaAlpha};minGain=${minGainValue}` +
    `;batch=${gainRepairBatchSize};maxTotal=${gainRepairMaxTotal ?? "null"}` +
    `;interval=${gainRepairIntervalMs};gen=${gainRepairRescreenGeneration}`
  );
}
