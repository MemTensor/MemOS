/**
 * `gain-maintenance.ts` — maintenance back-end: the
 * read-only `policies.gainPreview` and the policy-field CAS
 * `policies.gainRollback`. Called ONLY from the two `MemoryCore` maintenance
 * methods (which resolve the exact namespace + live config slice); the timer
 * engine (`gain-repair.ts`) never calls this module and this module never
 * calls the engine.
 *
 * Preview is a sanity check, not a frozen approval artifact: it recomputes
 * through the shared helper in `preview` mode (which forces v2 scoring
 * regardless of the enable flag) and performs ZERO writes — no queue/journal/
 * policy/trace/kv mutation of any kind. The timer recomputes from fresh
 * evidence on every tick, so a preview neither authorizes nor locks in a
 * future repair.
 *
 * Rollback restores ONLY repair-owned policy fields (gain/version/status) to
 * their journaled pre-repair values after a five-field CAS
 * (status/support/gain/gain_version/updated_at) against the recorded
 * post-write state. It preserves support and every trace/link row, stamps a
 * FRESH updated_at (historical timestamps are never restored), marks the
 * journal rows `rolled_back` and parks the queue entries `blocked`
 * atomically, and never refunds the budget counter.
 *
 * Operational notes (operator steps, NOT code enforcement):
 *
 *   • Pause repair BEFORE assessing a rollback (`gainRepairBatchSize: 0`
 *     while retaining v2 scoring); otherwise the timer can re-repair a
 *     rolled-back entry on the next tick and the CAS will rightly refuse a
 *     second rollback of the same batch.
 *   • Resumption of rolled-back entries uses the config re-screen generation
 *     (bump `gainRepairRescreenGeneration`): the re-screen un-stamps their
 *     evidence, re-screens it at the current inference version and requeues
 *     the entries when resolved. There is no separate approval or requeue
 *     flow, and preview stays read-only.
 *   • Journal history stays available through the existing journal reads
 *     (`getJournalById` / `listJournalByBatch`); no dedicated journal-listing
 *     RPC was added.
 *   • Before first enable, take a WAL-consistent SQLite backup and verify it
 *     with `quick_check` as disaster recovery. That snapshot is the restore
 *     path for operational mistakes; `gainRollback` is a policy-field repair
 *     tool, not a substitute for full-database restore.
 */

import { MemosError } from "../../../agent-contract/errors.js";
import type {
  GainPreviewPolicyEntry,
  GainPreviewResult,
  GainRollbackConflict,
  GainRollbackResult,
} from "../../../agent-contract/memory-core.js";
import {
  GAIN_INFERENCE_VERSION,
  GAIN_POST_CUTOVER_BOUNDARY_MS,
} from "../../reward/gain-inference.js";
import type { Repos } from "../../storage/repos/index.js";
import type { GainRepairJournalRow } from "../../storage/repos/gain-repair.js";
import type { StorageDb } from "../../storage/types.js";
import type { PolicyId, PolicyRow } from "../../types.js";
import {
  namespaceFromOwner,
  readGainRepairBudget,
  type GainRepairOwner,
} from "./gain-repair.js";
import { isExactOwner } from "../../storage/repos/_helpers.js";
import { recomputePolicyGain } from "./recompute-gain.js";
import type { L2Config } from "./types.js";

export interface GainMaintenanceDeps {
  db: StorageDb;
  repos: Pick<
    Repos,
    "episodes" | "gainRepair" | "kv" | "policies" | "tracePolicyLinks" | "traces"
  >;
  /** Live L2 config slice (same shape the timer builds per tick). */
  config: L2Config;
  /** Exact namespace of the caller — every read and write is scoped to it. */
  owner: GainRepairOwner;
  /** Live promotion thresholds (repair never archives, so no archive gate). */
  thresholds: { minSupport: number; minGain: number };
  inferenceVersion?: number;
  now?: () => number;
}

export interface GainPreviewOptions {
  limit?: number;
  offset?: number;
}

export interface GainRollbackOptions {
  batchId?: string;
  journalIds?: readonly string[];
}

// ─── policies.gainPreview ────────────────────────────────────────────────────

export function previewGainRepair(
  deps: GainMaintenanceDeps,
  opts: GainPreviewOptions = {},
): GainPreviewResult {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const { owner } = deps;
  const version = deps.inferenceVersion ?? GAIN_INFERENCE_VERSION;
  const namespace = namespaceFromOwner(owner);

  // Repair universe: candidate/active policies of the EXACT namespace.
  // Added owner-scoped SQL filter to avoid loading 200k rows into memory.
  const policies = [
    ...deps.repos.policies.list({
      status: "candidate",
      limit: 100_000,
      ownerAgentKind: owner.ownerAgentKind,
      ownerProfileId: owner.ownerProfileId,
      ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
    }),
    ...deps.repos.policies.list({
      status: "active",
      limit: 100_000,
      ownerAgentKind: owner.ownerAgentKind,
      ownerProfileId: owner.ownerProfileId,
      ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
    }),
  ].filter((p) => isExactOwner(p, owner));

  const queueByPolicy = new Map<string, GainPreviewPolicyEntry["queue"]>();
  for (const state of ["pending", "blocked", "claimed"] as const) {
    for (const row of deps.repos.gainRepair.listByOwnerAndState(owner, state)) {
      queueByPolicy.set(String(row.policyId), {
        state,
        reason: row.reason,
        blockedReason: row.blockedReason,
        attemptCount: row.attemptCount,
        inferenceVersion: row.inferenceVersion,
      });
    }
  }

  const entries: GainPreviewPolicyEntry[] = policies.map((policy) => {
    const recomputed = recomputePolicyGain(
      { policy, namespace, config: deps.config, mode: "preview" },
      {
        episodes: deps.repos.episodes,
        traces: deps.repos.traces,
        tracePolicyLinks: deps.repos.tracePolicyLinks,
      },
    );
    let proposedTransition: GainPreviewPolicyEntry["proposedTransition"];
    // Unknown-owner policies are reported with their computed values but
    // never proposed for auto-mutation: the timer must not touch them, so
    // the preview must not suggest that it will.
    const skipReason =
      recomputed.skipReason ?? (recomputed.unknownOwner ? "unknown_owner" : null);
    if (skipReason !== null) {
      proposedTransition = "none";
    } else if (policy.status === "active") {
      // Timer repair refreshes active gains but never archives.
      proposedTransition = "retain_active";
    } else if (
      policy.support >= deps.thresholds.minSupport &&
      recomputed.persistedGain >= deps.thresholds.minGain
    ) {
      proposedTransition = "promote_to_active";
    } else {
      proposedTransition = "retain_candidate";
    }
    return {
      policyId: String(policy.id),
      title: policy.title,
      // The universe above selects candidate/active only; archived rows
      // never reach this mapping.
      status: policy.status as "candidate" | "active",
      support: policy.support,
      oldGain: policy.gain,
      oldGainVersion: policy.gainVersion ?? 1,
      rawGain: recomputed.raw.gain,
      newGain: recomputed.persistedGain,
      newGainVersion: recomputed.gainVersion,
      resolvedWith: recomputed.selectedWithIds.length,
      resolvedWithout: recomputed.selectedWithoutIds.length,
      provenance: { ...recomputed.provenance },
      excluded: { ...recomputed.excluded },
      reported: { ...recomputed.reported },
      proposedTransition,
      skipReason,
      unknownOwner: recomputed.unknownOwner,
      queue: queueByPolicy.get(String(policy.id)) ?? null,
    };
  });

  // Rank: candidates first (timer selection order), then proposed gain desc,
  // support desc, policy-ID asc. Deterministic across calls.
  entries.sort((a, b) => {
    const statusRank = (s: string): number => (s === "candidate" ? 0 : 1);
    const rank = statusRank(a.status) - statusRank(b.status);
    if (rank !== 0) return rank;
    if (a.newGain !== b.newGain) return b.newGain - a.newGain;
    if (a.support !== b.support) return b.support - a.support;
    return a.policyId < b.policyId ? -1 : a.policyId > b.policyId ? 1 : 0;
  });

  return {
    policies: entries.slice(offset, offset + limit),
    total: entries.length,
    limit,
    offset,
    queue: {
      pending: deps.repos.gainRepair.countByState(owner, "pending"),
      blocked: deps.repos.gainRepair.countByState(owner, "blocked"),
      claimed: deps.repos.gainRepair.countByState(owner, "claimed"),
    },
    budget: readGainRepairBudget(deps.repos.kv, owner, deps.config.gainRepairMaxTotal),
    inferenceVersion: version,
    legacy: legacySummary(deps, owner),
  };
}

/**
 * Current-state legacy_unscaled summary for the exact namespace, grouped by
 * stored episode: group/trace totals plus the post-cutover cohort (newest
 * member on/after 2026-06-22T00:00:00Z) and the unknown-chronology cohort.
 * Chronology follows the inference predicate (any member ts ≤ 0/non-finite
 * taints the whole group); the date is an audit boundary, never a gate.
 */
function legacySummary(
  deps: GainMaintenanceDeps,
  owner: GainRepairOwner,
): GainPreviewResult["legacy"] {
  const rows = deps.db.prepare<
    { kind: string; profile: string; workspace_id: string | null },
    { episode_id: string; n: number; newest_ts: number | null; unknown_n: number }
  >(
    `SELECT episode_id AS episode_id, COUNT(*) AS n, MAX(ts) AS newest_ts,
            SUM(CASE WHEN ts IS NULL OR ts <= 0 THEN 1 ELSE 0 END) AS unknown_n
       FROM traces
      WHERE owner_agent_kind = @kind
        AND owner_profile_id = @profile
        AND owner_workspace_id IS @workspace_id
        AND gain_value_source = 'legacy_unscaled'
      GROUP BY episode_id`,
  ).all({
    kind: owner.ownerAgentKind,
    profile: owner.ownerProfileId,
    workspace_id: owner.ownerWorkspaceId ?? null,
  });
  const out = {
    groups: 0,
    traces: 0,
    postCutoverGroups: 0,
    postCutoverTraces: 0,
    unknownChronologyGroups: 0,
    unknownChronologyTraces: 0,
  };
  for (const r of rows) {
    out.groups += 1;
    out.traces += r.n;
    const newest = r.newest_ts;
    const unknown = r.unknown_n > 0 || newest == null || !Number.isFinite(newest);
    if (unknown) {
      out.unknownChronologyGroups += 1;
      out.unknownChronologyTraces += r.n;
    } else if (newest >= GAIN_POST_CUTOVER_BOUNDARY_MS) {
      out.postCutoverGroups += 1;
      out.postCutoverTraces += r.n;
    }
  }
  return out;
}

// ─── policies.gainRollback ───────────────────────────────────────────────────

interface RollbackCandidate {
  journalId: string;
  policyId: PolicyId;
  policy: PolicyRow;
  oldGain: number;
  oldGainVersion: number;
  oldStatus: "candidate" | "active";
  newGain: number;
  newGainVersion: number;
  newStatus: string;
  newSupport: number;
  newUpdatedAt: number;
  inferenceVersion: number;
}

/**
 * Restore repair-owned policy fields after a five-field CAS. Compare phase
 * loads and checks EVERY requested row before the single apply transaction;
 * any mismatch rejects the whole batch with zero writes. Exact-namespace
 * authorization runs BEFORE any field comparison, even when fields would
 * match: foreign rows resolve to `not_found_or_forbidden` with a null
 * policyId so nothing leaks.
 */
export function rollbackGainRepair(
  deps: GainMaintenanceDeps,
  opts: GainRollbackOptions,
): GainRollbackResult {
  const batchId =
    typeof opts.batchId === "string" && opts.batchId.length > 0 ? opts.batchId : null;
  const journalIds = Array.isArray(opts.journalIds)
    ? opts.journalIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (batchId === null && journalIds.length === 0) {
    throw new MemosError(
      "invalid_argument",
      "policies.gainRollback: exactly one of 'batchId' / non-empty 'journalIds' is required",
    );
  }
  if (batchId !== null && journalIds.length > 0) {
    throw new MemosError(
      "invalid_argument",
      "policies.gainRollback: pass either 'batchId' or 'journalIds', not both",
    );
  }
  const { owner } = deps;

  // ── Resolve the requested rows (reads only) ──
  const requested: Array<{ journalId: string; row: GainRepairJournalRow | null }> = [];
  if (batchId !== null) {
    const rows = deps.repos.gainRepair.listJournalByBatch(batchId);
    const ownRows = rows.filter((r) => isExactOwner(r, owner));
    if (ownRows.length === 0) {
      // A batch with no rows in this namespace (foreign-only, or not at all)
      // is simply unknown here — the error reveals nothing about foreign rows.
      throw new MemosError(
        "invalid_argument",
        "policies.gainRollback: unknown batch in this namespace",
      );
    }
    for (const row of rows) {
      // Foreign-namespace batch rows are included as conflicts (not silently
      // dropped), matching the journalIds path behavior and preventing
      // partial cross-namespace rollbacks. A batch with no own rows at all
      // takes the unknown-batch path above, so its existence is not revealed.
      if (!isExactOwner(row, owner)) {
        requested.push({ journalId: row.id, row: null });
      } else {
        requested.push({ journalId: row.id, row });
      }
    }
  } else {
    for (const journalId of journalIds) {
      const row = deps.repos.gainRepair.getJournalById(journalId);
      requested.push({ journalId, row: row && isExactOwner(row, owner) ? row : null });
    }
  }

  // ── Compare phase: every row must prove eligibility + CAS match ──
  const conflicts: GainRollbackConflict[] = [];
  const candidates: RollbackCandidate[] = [];
  const seenPolicies = new Map<string, string>();
  for (const { journalId, row } of requested) {
    if (!row) {
      conflicts.push({ journalId, policyId: null, reason: "not_found_or_forbidden" });
      continue;
    }
    const eligible =
      row.result === "completed" &&
      row.policyId != null &&
      row.oldGain != null &&
      row.newGain != null &&
      row.oldGainVersion != null &&
      row.newGainVersion != null &&
      row.oldStatus != null &&
      row.newStatus != null &&
      row.oldSupport != null &&
      row.newSupport != null &&
      row.newUpdatedAt != null &&
      (row.oldStatus === "candidate" || row.oldStatus === "active");
    if (!eligible) {
      // Pending/blocked/conflicted/failed/rolled-back rows and completed rows
      // that never recorded the post-write timestamp can never prove
      // post-write ownership.
      conflicts.push({
        journalId,
        policyId: row.policyId != null ? String(row.policyId) : null,
        reason: "not_rollback_eligible",
      });
      continue;
    }
    const policyKey = String(row.policyId);
    const firstSeen = seenPolicies.get(policyKey);
    if (firstSeen !== undefined) {
      conflicts.push({ journalId, policyId: policyKey, reason: "duplicate_policy_entries" });
      continue;
    }
    seenPolicies.set(policyKey, journalId);
    const policy = deps.repos.policies.getById(row.policyId as PolicyId);
    if (!policy) {
      conflicts.push({ journalId, policyId: policyKey, reason: "policy_missing" });
      continue;
    }
    if (!isExactOwner(policy, owner)) {
      conflicts.push({ journalId, policyId: null, reason: "not_found_or_forbidden" });
      continue;
    }
    const cas: Array<{
      field: NonNullable<GainRollbackConflict["field"]>;
      current: number | string;
      recorded: number | string;
    }> = [
      { field: "status", current: policy.status, recorded: row.newStatus as string },
      { field: "support", current: policy.support, recorded: row.newSupport as number },
      { field: "gain", current: policy.gain, recorded: row.newGain as number },
      {
        field: "gain_version",
        current: policy.gainVersion ?? 1,
        recorded: row.newGainVersion as number,
      },
      { field: "updated_at", current: policy.updatedAt, recorded: row.newUpdatedAt as number },
    ];
    const mismatch = cas.find((c) => c.current !== c.recorded);
    if (mismatch) {
      // A newer support/gain/status/timestamp write after the repair owns
      // this policy now — never overwrite it. No evidence/link/config
      // comparison is performed: unrelated evidence changes do not block
      // rollback while the five policy fields still match.
      conflicts.push({
        journalId,
        policyId: policyKey,
        reason: "policy_changed",
        field: mismatch.field,
      });
      continue;
    }
    candidates.push({
      journalId,
      policyId: row.policyId as PolicyId,
      policy,
      oldGain: row.oldGain as number,
      oldGainVersion: row.oldGainVersion as number,
      oldStatus: row.oldStatus as "candidate" | "active",
      newGain: row.newGain as number,
      newGainVersion: row.newGainVersion as number,
      newStatus: row.newStatus as string,
      newSupport: row.newSupport as number,
      newUpdatedAt: row.newUpdatedAt as number,
      inferenceVersion: row.inferenceVersion,
    });
  }
  if (conflicts.length > 0) {
    return { ok: false, batchId, conflicts };
  }

  // ── Apply phase: one atomic transaction for the whole batch ──
  const now = deps.now?.() ?? Date.now();
  const rolledBack = deps.db.tx(() => {
    const out: Array<{ journalId: string; policyId: string }> = [];
    for (const c of candidates) {
      deps.repos.policies.updateStats(c.policyId, {
        // Restore ONLY the repair-owned fields; support is preserved and
        // updated_at is fresh — historical timestamps are never restored.
        support: c.policy.support,
        gain: c.oldGain,
        gainVersion: c.oldGainVersion,
        status: c.oldStatus,
        updatedAt: now,
      });
      deps.repos.gainRepair.setJournalResult(c.journalId, "rolled_back");
      // Park the queue entry blocked: resumption goes through the config
      // re-screen generation (operator bumps `gainRepairRescreenGeneration`),
      // never a separate approval flow.
      deps.repos.gainRepair.upsertBlocked({
        policyId: c.policyId,
        ownerAgentKind: owner.ownerAgentKind,
        ownerProfileId: owner.ownerProfileId,
        ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
        reason: "manual",
        blockedReason: "rolled_back",
        inferenceVersion: c.inferenceVersion,
        now,
      });
      out.push({ journalId: c.journalId, policyId: String(c.policyId) });
    }
    return out;
  });
  return { ok: true, batchId, rolledBack, rolledBackAt: now };
}
