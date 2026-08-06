import type { CandidatePoolRow, PolicyId } from "../../types.js";
import type { PageOptions, StorageDb } from "../types.js";
import { buildInsert, buildUpdate } from "../tx.js";
import { buildPageClauses, fromJsonText, ownerFieldsFromRaw, ownerParamsFromRow, toJsonText } from "./_helpers.js";

const COLUMNS = [
  "id",
  "owner_agent_kind",
  "owner_profile_id",
  "owner_workspace_id",
  "policy_id",
  "evidence_trace_ids_json",
  "signature",
  "similarity",
  "expires_at",
];

export function makeCandidatePoolRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "l2_candidate_pool", columns: COLUMNS }));
  const update = db.prepare(
    buildUpdate({
      table: "l2_candidate_pool",
      columns: ["id", "policy_id", "evidence_trace_ids_json", "similarity", "expires_at"],
    }),
  );
  const selectBySignature = db.prepare<{ sig: string }, RawCandidateRow>(
    `SELECT ${COLUMNS.join(", ")} FROM l2_candidate_pool WHERE signature=@sig ORDER BY similarity DESC`,
  );
  const selectById = db.prepare<{ id: string }, RawCandidateRow>(
    `SELECT ${COLUMNS.join(", ")} FROM l2_candidate_pool WHERE id=@id`,
  );
  const deleteExpired = db.prepare<{ now: number }>(
    `DELETE FROM l2_candidate_pool WHERE expires_at < @now`,
  );
  const deleteById = db.prepare<{ id: string }>(
    `DELETE FROM l2_candidate_pool WHERE id=@id`,
  );
  const promote = db.prepare<{ id: string; policyId: PolicyId }>(
    `UPDATE l2_candidate_pool SET policy_id=@policyId WHERE id=@id`,
  );

  return {
    insert(row: CandidatePoolRow): void {
      insert.run({
        id: row.id,
        ...ownerParamsFromRow(row),
        policy_id: row.policyId,
        evidence_trace_ids_json: toJsonText(row.evidenceTraceIds),
        signature: row.signature,
        similarity: row.similarity,
        expires_at: row.expiresAt,
      });
    },

    upsert(row: CandidatePoolRow): void {
      const existing = selectById.get({ id: row.id });
      if (existing) {
        update.run({
          id: row.id,
          policy_id: row.policyId,
          evidence_trace_ids_json: toJsonText(row.evidenceTraceIds),
          similarity: row.similarity,
          expires_at: row.expiresAt,
        });
      } else {
        this.insert(row);
      }
    },

    getById(id: string): CandidatePoolRow | null {
      const r = selectById.get({ id });
      return r ? mapRow(r) : null;
    },

    listBySignature(signature: string): CandidatePoolRow[] {
      return selectBySignature.all({ sig: signature }).map(mapRow);
    },

    list(opts: PageOptions = {}): CandidatePoolRow[] {
      const page = buildPageClauses(opts, "expires_at");
      return db
        .prepare<unknown, RawCandidateRow>(
          `SELECT ${COLUMNS.join(", ")} FROM l2_candidate_pool ${page}`,
        )
        .all()
        .map(mapRow);
    },

    prune(nowMs: number): number {
      return deleteExpired.run({ now: nowMs }).changes;
    },

    delete(id: string): void {
      deleteById.run({ id });
    },

    promote(id: string, policyId: PolicyId): void {
      promote.run({ id, policyId });
    },
  };
}

interface RawCandidateRow {
  id: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  policy_id: string | null;
  evidence_trace_ids_json: string;
  signature: string;
  similarity: number;
  expires_at: number;
}

function mapRow(r: RawCandidateRow): CandidatePoolRow {
  return {
    id: r.id,
    ...ownerFieldsFromRaw(r),
    policyId: r.policy_id,
    evidenceTraceIds: fromJsonText(r.evidence_trace_ids_json, []),
    signature: r.signature,
    similarity: r.similarity,
    expiresAt: r.expires_at,
  };
}
