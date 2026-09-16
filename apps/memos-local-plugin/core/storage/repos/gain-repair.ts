/**
 * `gain-repair.ts` — repair queue + journal repo.
 *
 * Schema surface: the schema exists via migration 19; this repo
 * provides the queue read/reconcile operations used by the idempotent
 * inference pass at startup (seed/reconcile candidate/active repair work) and
 * a journal writer for later phases. Policy FIELD writes belong to the
 * transaction layer, never to this repo.
 *
 * Queue is keyed by policy ID with pending/blocked/claimed state plus reason
 * and attempt metadata. Archived policies are never repair targets; entries
 * whose policy is archived or missing are reconciled away.
 *
 * Journal surface: journal reads (`getJournalById`,
 * `listJournalByBatch`) plus the recorded post-write timestamp
 * (`new_updated_at`, migration 19) and the `rolled_back` result marker back
 * the `policies.gainRollback` CAS. Policy FIELD writes still belong to the
 * transaction layer (the rollback commit), never to this repo.
 */

import { now } from "../../time.js";
import type { PolicyId } from "../../types.js";
import type { StorageDb } from "../types.js";
import { buildInsert } from "../tx.js";
import { fromJsonText, ownerFieldsFromRaw, toJsonText } from "./_helpers.js";

export type GainRepairQueueState = "pending" | "blocked" | "claimed";

export type GainRepairQueueReason =
  | "inferred_evidence_updated"
  | "inference_refresh"
  | "blocked_evidence"
  | "manual";

export interface GainRepairQueueRow {
  policyId: PolicyId;
  ownerAgentKind: string;
  ownerProfileId: string;
  ownerWorkspaceId: string | null;
  state: GainRepairQueueState;
  reason: GainRepairQueueReason | null;
  attemptCount: number;
  lastAttemptAt: number | null;
  lastAttemptBatchId: string | null;
  inferenceVersion: number;
  blockedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GainRepairJournalRow {
  id: string;
  batchId: string;
  ownerAgentKind: string;
  ownerProfileId: string;
  ownerWorkspaceId: string | null;
  policyId: PolicyId | null;
  oldGain: number | null;
  newGain: number | null;
  oldGainVersion: number | null;
  newGainVersion: number | null;
  oldStatus: string | null;
  newStatus: string | null;
  oldSupport: number | null;
  newSupport: number | null;
  algorithmVersion: string | null;
  configVersion: string | null;
  inferenceVersion: number;
  provenance: string[];
  excludedWithCount: number;
  excludedWithoutCount: number;
  result: "pending" | "completed" | "blocked" | "conflicted" | "failed" | "rolled_back";
  createdAt: number;
  /**
   * (migration 19) — the policy `updated_at` written by the
   * completing repair attempt. NULL for rows that never recorded it and for
   * non-completing outcomes; such rows are NOT rollback-eligible because the
   * five-field CAS cannot prove the exact post-write state.
   */
  newUpdatedAt: number | null;
}

const QUEUE_COLUMNS = [
  "policy_id",
  "owner_agent_kind",
  "owner_profile_id",
  "owner_workspace_id",
  "state",
  "reason",
  "attempt_count",
  "last_attempt_at",
  "last_attempt_batch_id",
  "inference_version",
  "blocked_reason",
  "created_at",
  "updated_at",
];

const JOURNAL_COLUMNS = [
  "id",
  "batch_id",
  "owner_agent_kind",
  "owner_profile_id",
  "owner_workspace_id",
  "policy_id",
  "old_gain",
  "new_gain",
  "old_gain_version",
  "new_gain_version",
  "old_status",
  "new_status",
  "old_support",
  "new_support",
  "algorithm_version",
  "config_version",
  "inference_version",
  "provenance_json",
  "excluded_with_count",
  "excluded_without_count",
  "result",
  "created_at",
  "new_updated_at",
];

export interface GainRepairPendingTarget {
  policyId: PolicyId;
  reason: GainRepairQueueReason | null;
  attemptCount: number;
  inferenceVersion: number;
  blockedReason: string | null;
  policyStatus: "candidate" | "active";
  policyGainVersion: number;
  policySupport: number;
}

export interface GainRepairJournalOutcomePatch {
  newGain?: number | null;
  newGainVersion?: number | null;
  newStatus?: string | null;
  newSupport?: number | null;
  /** Post-write policy `updated_at` — set only by the completing repair path. */
  newUpdatedAt?: number | null;
  provenance?: string[];
  excludedWithCount?: number;
  excludedWithoutCount?: number;
  result: GainRepairJournalRow["result"];
}

export function makeGainRepairRepo(db: StorageDb) {
  const upsertQueue = db.prepare(
    `INSERT INTO gain_repair_queue (${QUEUE_COLUMNS.join(", ")})
     VALUES (${QUEUE_COLUMNS.map((c) => `@${c}`).join(", ")})
     ON CONFLICT(policy_id) DO UPDATE SET
       state = excluded.state,
       reason = excluded.reason,
       inference_version = excluded.inference_version,
       blocked_reason = excluded.blocked_reason,
       updated_at = excluded.updated_at`,
  );
  const insertJournal = db.prepare(buildInsert({ table: "gain_repair_journal", columns: JOURNAL_COLUMNS }));
  const selectByPolicy = db.prepare<{ policy_id: string }, RawQueueRow>(
    `SELECT ${QUEUE_COLUMNS.join(", ")} FROM gain_repair_queue WHERE policy_id=@policy_id`,
  );
  const selectByOwnerAndState = db.prepare<
    { kind: string; profile: string; workspace_id: string | null; state: string },
    RawQueueRow
  >(
    `SELECT ${QUEUE_COLUMNS.join(", ")} FROM gain_repair_queue
     WHERE owner_agent_kind=@kind
       AND owner_profile_id=@profile
       AND owner_workspace_id IS @workspace_id
       AND state=@state
     ORDER BY policy_id`,
  );
  // Candidate-first selection: pending entries whose policy is still a
  // repair target (candidate/active, never archived), stable ID order.
  const selectPendingForRepair = db.prepare<
    { kind: string; profile: string; workspace_id: string | null; limit: number },
    RawQueueRow & {
      policy_status: "candidate" | "active";
      policy_gain_version: number;
      policy_support: number;
    }
  >(
    `SELECT q.${QUEUE_COLUMNS.join(", q.")}, p.status AS policy_status,
            p.gain_version AS policy_gain_version, p.support AS policy_support
       FROM gain_repair_queue q
       JOIN policies p ON p.id = q.policy_id
      WHERE q.owner_agent_kind=@kind
        AND q.owner_profile_id=@profile
        AND q.owner_workspace_id IS @workspace_id
        AND q.state='pending'
        AND p.status IN ('candidate','active')
      ORDER BY CASE WHEN p.status='candidate' THEN 0 ELSE 1 END, q.policy_id
      LIMIT @limit`,
  );
  const selectBlockedByOwner = db.prepare<
    { kind: string; profile: string; workspace_id: string | null },
    RawQueueRow
  >(
    `SELECT ${QUEUE_COLUMNS.join(", ")} FROM gain_repair_queue
     WHERE owner_agent_kind=@kind
       AND owner_profile_id=@profile
       AND owner_workspace_id IS @workspace_id
       AND state='blocked'
     ORDER BY policy_id`,
  );
  const deleteByPolicy = db.prepare<{ policy_id: string }>(
    `DELETE FROM gain_repair_queue WHERE policy_id=@policy_id`,
  );
  const deleteByOwner = db.prepare<{ kind: string; profile: string; workspace_id: string | null }>(
    `DELETE FROM gain_repair_queue
     WHERE owner_agent_kind=@kind
       AND owner_profile_id=@profile
       AND owner_workspace_id IS @workspace_id`,
  );
  const updateQueueState = db.prepare<{
    policy_id: string;
    state: GainRepairQueueState;
    attempt_count?: number | null;
    last_attempt_at?: number | null;
    last_attempt_batch_id?: string | null;
    blocked_reason?: string | null;
    updated_at: number;
  }>(
    `UPDATE gain_repair_queue
        SET state=@state,
            attempt_count=COALESCE(@attempt_count, attempt_count),
            last_attempt_at=COALESCE(@last_attempt_at, last_attempt_at),
            last_attempt_batch_id=COALESCE(@last_attempt_batch_id, last_attempt_batch_id),
            blocked_reason=COALESCE(@blocked_reason, blocked_reason),
            updated_at=@updated_at
      WHERE policy_id=@policy_id`,
  );
  const updateJournalOutcome = db.prepare<{
    id: string;
    new_gain: number | null;
    new_gain_version: number | null;
    new_status: string | null;
    new_support: number | null;
    new_updated_at: number | null;
    provenance_json: string;
    excluded_with_count: number;
    excluded_without_count: number;
    result: GainRepairJournalRow["result"];
  }>(
    `UPDATE gain_repair_journal
        SET new_gain=@new_gain,
            new_gain_version=@new_gain_version,
            new_status=@new_status,
            new_support=@new_support,
            new_updated_at=@new_updated_at,
            provenance_json=@provenance_json,
            excluded_with_count=@excluded_with_count,
            excluded_without_count=@excluded_without_count,
            result=@result
      WHERE id=@id`,
  );
  const selectJournalById = db.prepare<{ id: string }, RawJournalRow>(
    `SELECT ${JOURNAL_COLUMNS.join(", ")} FROM gain_repair_journal WHERE id=@id`,
  );
  // deterministic policy-ID order so batch rollback reports and
  // applies in a stable sequence.
  const selectJournalByBatch = db.prepare<{ batch_id: string }, RawJournalRow>(
    `SELECT ${JOURNAL_COLUMNS.join(", ")} FROM gain_repair_journal
      WHERE batch_id=@batch_id
      ORDER BY policy_id`,
  );
  const setJournalResult = db.prepare<{ id: string; result: GainRepairJournalRow["result"] }>(
    `UPDATE gain_repair_journal SET result=@result WHERE id=@id`,
  );
  const markJournalInterrupted = db.prepare<{ policy_id: string; batch_id: string }>(
    `UPDATE gain_repair_journal SET result='failed'
      WHERE policy_id=@policy_id AND batch_id=@batch_id AND result='pending'`,
  );

  return {
    upsertPending(row: {
      policyId: PolicyId;
      ownerAgentKind: string;
      ownerProfileId: string;
      ownerWorkspaceId?: string | null;
      reason?: GainRepairQueueReason | null;
      inferenceVersion?: number;
      now?: number;
    }): void {
      const ts = row.now ?? now();
      upsertQueue.run({
        policy_id: row.policyId,
        owner_agent_kind: row.ownerAgentKind,
        owner_profile_id: row.ownerProfileId,
        owner_workspace_id: row.ownerWorkspaceId ?? null,
        state: "pending",
        reason: row.reason ?? null,
        attempt_count: 0,
        last_attempt_at: null,
        last_attempt_batch_id: null,
        inference_version: row.inferenceVersion ?? 1,
        blocked_reason: null,
        created_at: ts,
        updated_at: ts,
      });
    },

    /**
     * Seed a policy directly as blocked (zero resolved with-links,
     * no attempt, no budget). Writing `blocked` also clears attempt state so a
     * re-screen generation can flip it back to `pending` cleanly.
     */
    upsertBlocked(row: {
      policyId: PolicyId;
      ownerAgentKind: string;
      ownerProfileId: string;
      ownerWorkspaceId?: string | null;
      reason?: GainRepairQueueReason | null;
      blockedReason?: string | null;
      inferenceVersion?: number;
      now?: number;
    }): void {
      const ts = row.now ?? now();
      upsertQueue.run({
        policy_id: row.policyId,
        owner_agent_kind: row.ownerAgentKind,
        owner_profile_id: row.ownerProfileId,
        owner_workspace_id: row.ownerWorkspaceId ?? null,
        state: "blocked",
        reason: row.reason ?? null,
        attempt_count: 0,
        last_attempt_at: null,
        last_attempt_batch_id: null,
        inference_version: row.inferenceVersion ?? 1,
        blocked_reason: row.blockedReason ?? null,
        created_at: ts,
        updated_at: ts,
      });
    },

    insertJournal(row: GainRepairJournalRow): void {
      insertJournal.run({
        id: row.id,
        batch_id: row.batchId,
        owner_agent_kind: row.ownerAgentKind,
        owner_profile_id: row.ownerProfileId,
        owner_workspace_id: row.ownerWorkspaceId,
        policy_id: row.policyId,
        old_gain: row.oldGain,
        new_gain: row.newGain,
        old_gain_version: row.oldGainVersion,
        new_gain_version: row.newGainVersion,
        old_status: row.oldStatus,
        new_status: row.newStatus,
        old_support: row.oldSupport,
        new_support: row.newSupport,
        algorithm_version: row.algorithmVersion,
        config_version: row.configVersion,
        inference_version: row.inferenceVersion,
        provenance_json: toJsonText(row.provenance),
        excluded_with_count: row.excludedWithCount,
        excluded_without_count: row.excludedWithoutCount,
        result: row.result,
        created_at: row.createdAt,
        new_updated_at: row.newUpdatedAt ?? null,
      });
    },

    /**
     * read one journal row by ID. The rollback layer enforces
     * exact-namespace authorization on the returned owner columns; a row from
     * another namespace must be treated as not-found, never surfaced.
     */
    getJournalById(id: string): GainRepairJournalRow | null {
      const r = selectJournalById.get({ id });
      return r ? mapJournalRow(r) : null;
    },

    /**
     * every journal row of one attempt batch, stable policy-ID
     * order. Callers filter to their exact namespace; foreign rows are
     * invisible (the batch is "unknown" outside its namespace).
     */
    listJournalByBatch(batchId: string): GainRepairJournalRow[] {
      return selectJournalByBatch.all({ batch_id: batchId }).map(mapJournalRow);
    },

    /**
     * mark a journal row `rolled_back` after a successful CAS
     * rollback. Touches ONLY the result marker; the recorded old/new fields
     * stay intact as the audit trail (a second rollback attempt sees
     * `rolled_back` and is refused as not eligible).
     */
    setJournalResult(id: string, result: GainRepairJournalRow["result"]): void {
      setJournalResult.run({ id, result });
    },

    getByPolicy(policyId: PolicyId): GainRepairQueueRow | null {
      const r = selectByPolicy.get({ policy_id: String(policyId) });
      return r ? mapQueueRow(r) : null;
    },

    /**
     * pending repair targets of an exact owner, candidate first then
     * stable policy-ID order. Joins policies so archived/missing targets are
     * never selected.
     */
    listPendingForRepair(
      owner: { ownerAgentKind: string; ownerProfileId: string; ownerWorkspaceId?: string | null },
      limit: number,
    ): GainRepairPendingTarget[] {
      const rows = selectPendingForRepair.all({
        kind: owner.ownerAgentKind,
        profile: owner.ownerProfileId,
        workspace_id: owner.ownerWorkspaceId ?? null,
        limit: Math.max(0, Math.floor(limit)),
      });
      return rows.map((r) => ({
        policyId: r.policy_id as PolicyId,
        reason: r.reason,
        attemptCount: r.attempt_count,
        inferenceVersion: r.inference_version,
        blockedReason: r.blocked_reason,
        policyStatus: r.policy_status,
        policyGainVersion: r.policy_gain_version,
        policySupport: r.policy_support,
      }));
    },

    listByOwnerAndState(
      owner: { ownerAgentKind: string; ownerProfileId: string; ownerWorkspaceId?: string | null },
      state: GainRepairQueueState,
    ): GainRepairQueueRow[] {
      return selectByOwnerAndState
        .all({
          kind: owner.ownerAgentKind,
          profile: owner.ownerProfileId,
          workspace_id: owner.ownerWorkspaceId ?? null,
          state,
        })
        .map(mapQueueRow);
    },

    listBlockedByOwner(owner: {
      ownerAgentKind: string;
      ownerProfileId: string;
      ownerWorkspaceId?: string | null;
    }): GainRepairQueueRow[] {
      return selectBlockedByOwner
        .all({
          kind: owner.ownerAgentKind,
          profile: owner.ownerProfileId,
          workspace_id: owner.ownerWorkspaceId ?? null,
        })
        .map(mapQueueRow);
    },

    /**
     * transition an entry to a new state while PRESERVING attempt
     * metadata unless explicitly overridden. The timer engine owns these
     * transitions (always inside a `db.tx` reservation/outcome commit).
     */
    setQueueState(
      policyId: PolicyId,
      patch: {
        state: GainRepairQueueState;
        attemptCount?: number;
        lastAttemptAt?: number | null;
        lastAttemptBatchId?: string | null;
        blockedReason?: string | null;
        now?: number;
      },
    ): void {
      updateQueueState.run({
        policy_id: String(policyId),
        state: patch.state,
        attempt_count: patch.attemptCount ?? null,
        last_attempt_at: patch.lastAttemptAt ?? null,
        last_attempt_batch_id: patch.lastAttemptBatchId ?? null,
        blocked_reason: patch.blockedReason ?? null,
        updated_at: patch.now ?? now(),
      });
    },

    /**
     * write the final journal outcome for one attempt. The row was
     * inserted at reservation with result='pending' (the claim marker); this
     * completes it with the post-attempt fields. `null` provenance is
     * preserved as the stored default when omitted.
     */
    updateJournalOutcome(id: string, patch: GainRepairJournalOutcomePatch): void {
      updateJournalOutcome.run({
        id,
        new_gain: patch.newGain ?? null,
        new_gain_version: patch.newGainVersion ?? null,
        new_status: patch.newStatus ?? null,
        new_support: patch.newSupport ?? null,
        new_updated_at: patch.newUpdatedAt ?? null,
        provenance_json: toJsonText(patch.provenance ?? []),
        excluded_with_count: patch.excludedWithCount ?? 0,
        excluded_without_count: patch.excludedWithoutCount ?? 0,
        result: patch.result,
      });
    },

    /**
     * close an interrupted claim's journal ledger: any row still
     * `pending` for this policy/batch is marked `failed` (the reservation
     * consumed its budget unit but the per-policy transaction never
     * committed). Runs inside the interrupted-claim reconcile transaction.
     */
    markInterruptedJournal(policyId: PolicyId, batchId: string): void {
      markJournalInterrupted.run({ policy_id: String(policyId), batch_id: batchId });
    },

    removeByPolicy(policyId: PolicyId): void {
      deleteByPolicy.run({ policy_id: String(policyId) });
    },

    removeAllForOwner(owner: { ownerAgentKind: string; ownerProfileId: string; ownerWorkspaceId?: string | null }): void {
      deleteByOwner.run({
        kind: owner.ownerAgentKind,
        profile: owner.ownerProfileId,
        workspace_id: owner.ownerWorkspaceId ?? null,
      });
    },

    /**
     * Policy IDs (candidate/active, same owner) whose `source_trace_ids_json`
     * intersects the affected trace set. Bounded bulk reads — chunked IN lists
     * over json_each, never one query per trace. Archived policies are never
     * repair targets and are excluded here. Policies with malformed or
     * non-array source lists match nothing (guarded expansion) instead of
     * aborting the query.
     */
    findAffectedPolicyIds(
      affectedTraceIds: ReadonlySet<string>,
      owner: { ownerAgentKind: string; ownerProfileId: string; ownerWorkspaceId?: string | null },
    ): PolicyId[] {
      if (affectedTraceIds.size === 0) return [];
      const ids = Array.from(affectedTraceIds);
      const found = new Set<string>();
      const CHUNK_SIZE = 900;
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map((_, j) => `@tid_${j}`).join(",");
        const params: Record<string, unknown> = {
          kind: owner.ownerAgentKind,
          profile: owner.ownerProfileId,
          workspace_id: owner.ownerWorkspaceId ?? null,
        };
        chunk.forEach((id, j) => {
          params[`tid_${j}`] = id;
        });
        // Guarded json_each: only a valid ARRAY feeds the expansion (nested
        // CASE idiom shared with the episodes.trace_ids_json handling in
        // gain-inference.ts). json_type() is evaluated ONLY inside
        // `CASE WHEN json_valid(...) = 1`, because bare json_type throws on
        // malformed JSON in this SQLite build (probed 2026-09-14). Malformed,
        // scalar, object, or NULL source lists degrade to '[]', so one bad
        // policy row is skipped instead of aborting queue reconciliation.
        const sql = `
          SELECT DISTINCT p.id AS id
          FROM policies p
          JOIN json_each(
            CASE WHEN json_valid(p.source_trace_ids_json) = 1
                 THEN (CASE WHEN json_type(p.source_trace_ids_json) = 'array'
                            THEN p.source_trace_ids_json ELSE '[]' END)
                 ELSE '[]' END
          ) AS je
          WHERE je.value IN (${placeholders})
            AND p.status IN ('candidate','active')
            AND p.owner_agent_kind = @kind
            AND p.owner_profile_id = @profile
            AND p.owner_workspace_id IS @workspace_id`;
        const rows = db.prepare<typeof params, { id: string }>(sql).all(params);
        for (const r of rows) found.add(r.id);
      }
      return Array.from(found).sort();
    },

    /**
     * Reconcile the queue against reality: drop entries whose policy is
     * archived (not a repair target) or no longer exists. Called at startup
     * after the inference pass, alongside seeding.
     */
    reconcileArchivedOrMissing(owner: {
      ownerAgentKind: string;
      ownerProfileId: string;
      ownerWorkspaceId?: string | null;
    }): number {
      const res = db
        .prepare<{ kind: string; profile: string; workspace_id: string | null }>(
          `DELETE FROM gain_repair_queue
           WHERE owner_agent_kind = @kind
             AND owner_profile_id = @profile
             AND owner_workspace_id IS @workspace_id
             AND (policy_id NOT IN (SELECT id FROM policies)
                  OR EXISTS (SELECT 1 FROM policies p WHERE p.id = gain_repair_queue.policy_id AND p.status = 'archived'))`,
        )
        .run({
          kind: owner.ownerAgentKind,
          profile: owner.ownerProfileId,
          workspace_id: owner.ownerWorkspaceId ?? null,
        });
      return Number(res.changes);
    },

    countByState(
      owner: { ownerAgentKind: string; ownerProfileId: string; ownerWorkspaceId?: string | null },
      state: GainRepairQueueState,
    ): number {
      const r = db
        .prepare<{ kind: string; profile: string; workspace_id: string | null; state: string }, { n: number }>(
          `SELECT COUNT(*) AS n FROM gain_repair_queue
           WHERE owner_agent_kind=@kind
             AND owner_profile_id=@profile
             AND owner_workspace_id IS @workspace_id
             AND state=@state`,
        )
        .get({
          kind: owner.ownerAgentKind,
          profile: owner.ownerProfileId,
          workspace_id: owner.ownerWorkspaceId ?? null,
          state,
        });
      return r?.n ?? 0;
    },
  };
}

interface RawQueueRow {
  policy_id: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  state: GainRepairQueueState;
  reason: GainRepairQueueReason | null;
  attempt_count: number;
  last_attempt_at: number | null;
  last_attempt_batch_id: string | null;
  inference_version: number;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

function mapQueueRow(r: RawQueueRow): GainRepairQueueRow {
  return {
    policyId: r.policy_id as PolicyId,
    ...ownerFieldsFromRaw(r),
    state: r.state,
    reason: r.reason,
    attemptCount: r.attempt_count,
    lastAttemptAt: r.last_attempt_at,
    lastAttemptBatchId: r.last_attempt_batch_id,
    inferenceVersion: r.inference_version,
    blockedReason: r.blocked_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface RawJournalRow {
  id: string;
  batch_id: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  policy_id: string | null;
  old_gain: number | null;
  new_gain: number | null;
  old_gain_version: number | null;
  new_gain_version: number | null;
  old_status: string | null;
  new_status: string | null;
  old_support: number | null;
  new_support: number | null;
  algorithm_version: string | null;
  config_version: string | null;
  inference_version: number;
  provenance_json: string;
  excluded_with_count: number;
  excluded_without_count: number;
  result: GainRepairJournalRow["result"];
  created_at: number;
  new_updated_at: number | null;
}

function mapJournalRow(r: RawJournalRow): GainRepairJournalRow {
  return {
    id: r.id,
    batchId: r.batch_id,
    ...ownerFieldsFromRaw(r),
    policyId: r.policy_id as PolicyId | null,
    oldGain: r.old_gain,
    newGain: r.new_gain,
    oldGainVersion: r.old_gain_version,
    newGainVersion: r.new_gain_version,
    oldStatus: r.old_status,
    newStatus: r.new_status,
    oldSupport: r.old_support,
    newSupport: r.new_support,
    algorithmVersion: r.algorithm_version,
    configVersion: r.config_version,
    inferenceVersion: r.inference_version,
    provenance: fromJsonText<string[]>(r.provenance_json, []),
    excludedWithCount: r.excluded_with_count,
    excludedWithoutCount: r.excluded_without_count,
    result: r.result,
    createdAt: r.created_at,
    newUpdatedAt: r.new_updated_at,
  };
}
