import type { EpisodeId, EpisodeRow, SessionId } from "../../types.js";
import type { EpisodeListFilter, StorageDb } from "../types.js";
import { buildInsert, buildUpdate } from "../tx.js";
import {
  buildPageClauses,
  fromJsonText,
  joinWhere,
  normalizeShareForStorage,
  ownerFieldsFromRaw,
  ownerParamsFromRow,
  timeRangeWhere,
  toJsonText,
} from "./_helpers.js";

const COLUMNS = [
  "id",
  "session_id",
  "owner_agent_kind",
  "owner_profile_id",
  "owner_workspace_id",
  "share_scope",
  "started_at",
  "ended_at",
  "trace_ids_json",
  "r_task",
  "verifier_passed",
  "outcome",
  "status",
  "meta_json",
];

export interface EpisodeMetaRow {
  meta?: Record<string, unknown>;
}

export function makeEpisodesRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "episodes", columns: COLUMNS }));
  const replace = db.prepare(
    buildInsert({ table: "episodes", columns: COLUMNS, onConflict: "replace" }),
  );
  const updateStatus = db.prepare(
    buildUpdate({ table: "episodes", columns: ["id", "status", "ended_at"] }),
  );
  const appendTrace = db.prepare(
    buildUpdate({ table: "episodes", columns: ["id", "trace_ids_json"] }),
  );
  const selectById = db.prepare<{ id: string }, RawEpisodeRow>(
    `SELECT ${COLUMNS.join(", ")} FROM episodes WHERE id=@id`,
  );
  const deleteById = db.prepare<{ id: string }>(
    `DELETE FROM episodes WHERE id=@id`,
  );
  const selectOpenForSession = db.prepare<{ session: string }, RawEpisodeRow>(
    `SELECT ${COLUMNS.join(", ")} FROM episodes WHERE session_id=@session AND status='open' ORDER BY started_at DESC LIMIT 1`,
  );

  return {
    insert(row: EpisodeRow & { meta?: Record<string, unknown> }): void {
      insert.run({
        id: row.id,
        session_id: row.sessionId,
        ...ownerParamsFromRow(row),
        share_scope: normalizeShareForStorage(row.share?.scope),
        started_at: row.startedAt,
        ended_at: row.endedAt ?? null,
        trace_ids_json: toJsonText(row.traceIds),
        r_task: row.rTask ?? null,
        verifier_passed: triStateToDb(row.verifierPassed),
        outcome: row.outcome ?? null,
        status: row.status,
        meta_json: toJsonText(row.meta ?? {}),
      });
    },

    upsert(row: EpisodeRow & { meta?: Record<string, unknown> }): void {
      replace.run({
        id: row.id,
        session_id: row.sessionId,
        ...ownerParamsFromRow(row),
        share_scope: normalizeShareForStorage(row.share?.scope),
        started_at: row.startedAt,
        ended_at: row.endedAt ?? null,
        trace_ids_json: toJsonText(row.traceIds),
        r_task: row.rTask ?? null,
        verifier_passed: triStateToDb(row.verifierPassed),
        outcome: row.outcome ?? null,
        status: row.status,
        meta_json: toJsonText(row.meta ?? {}),
      });
    },

    close(id: EpisodeId, endedAt: number, rTask?: number): void {
      updateStatus.run({ id, status: "closed", ended_at: endedAt });
      if (rTask !== undefined) {
        db.prepare<{ id: string; r: number }>(
          `UPDATE episodes SET r_task=@r WHERE id=@id`,
        ).run({ id, r: rTask });
      }
    },

    /**
     * Flip a closed episode back to `status='open'` (V7 §0.1 revision
     * path). Surgical UPDATE on the status column only — must NEVER
     * be implemented via `upsert`, which is `INSERT OR REPLACE` and
     * would cascade-delete every trace for the episode.
     */
    reopen(id: EpisodeId): void {
      db.prepare<{ id: string }>(
        `UPDATE episodes SET status='open', ended_at=NULL WHERE id=@id`,
      ).run({ id });
    },

    setRTask(id: EpisodeId, rTask: number): void {
      db.prepare<{ id: string; r: number }>(
        `UPDATE episodes SET r_task=@r WHERE id=@id`,
      ).run({ id, r: rTask });
    },

    setVerifierPassed(id: EpisodeId, verifierPassed: boolean | null): void {
      db.prepare<{ id: string; v: number | null }>(
        `UPDATE episodes SET verifier_passed=@v WHERE id=@id`,
      ).run({ id, v: triStateToDb(verifierPassed) });
    },

    setOutcome(id: EpisodeId, outcome: EpisodeRow["outcome"]): void {
      db.prepare<{ id: string; o: string | null }>(
        `UPDATE episodes SET outcome=@o WHERE id=@id`,
      ).run({ id, o: outcome ?? null });
    },

    updateMeta(id: EpisodeId, metaPatch: Record<string, unknown>): void {
      const current = selectById.get({ id });
      if (!current) return;
      const existing = fromJsonText<Record<string, unknown>>(current.meta_json, {});
      const merged = { ...existing, ...metaPatch };
      db.prepare<{ id: string; meta: string }>(
        `UPDATE episodes SET meta_json=@meta WHERE id=@id`,
      ).run({ id, meta: toJsonText(merged) });
    },

    /**
     * Lower the episode's `started_at` to an earlier value. Used by capture
     * after a manual-replay path inserts trace rows whose historical `ts`
     * predates the wall-clock `started_at` that was stamped when the
     * gateway opened the episode. Never moves `started_at` forward.
     */
    setStartedAt(id: EpisodeId, ts: number): void {
      db.prepare<{ id: string; ts: number }>(
        `UPDATE episodes SET started_at=@ts WHERE id=@id AND started_at > @ts`,
      ).run({ id, ts });
    },

    appendTrace(id: EpisodeId, traceIds: string[]): void {
      appendTrace.run({ id, trace_ids_json: toJsonText(traceIds) });
    },

    removeTraceIds(id: EpisodeId, traceIds: readonly string[]): void {
      if (traceIds.length === 0) return;
      const current = selectById.get({ id });
      if (!current) return;
      const remove = new Set(traceIds);
      const kept = fromJsonText<string[]>(current.trace_ids_json, []).filter(
        (traceId) => !remove.has(traceId),
      );
      appendTrace.run({ id, trace_ids_json: toJsonText(kept) });
    },

    deleteById(id: EpisodeId): void {
      deleteById.run({ id });
    },

    getById(id: EpisodeId): (EpisodeRow & EpisodeMetaRow) | null {
      const r = selectById.get({ id });
      if (!r) return null;
      return mapRow(r);
    },

    getOpenForSession(sessionId: SessionId): (EpisodeRow & EpisodeMetaRow) | null {
      const r = selectOpenForSession.get({ session: sessionId });
      if (!r) return null;
      return mapRow(r);
    },

    list(filter: EpisodeListFilter = {}): Array<EpisodeRow & EpisodeMetaRow> {
      const tr = timeRangeWhere(filter, "started_at");
      const fragments: string[] = [];
      const params: Record<string, unknown> = { ...tr.params };
      if (filter.sessionId) {
        fragments.push(`session_id = @session_id`);
        params.session_id = filter.sessionId;
      }
      if (filter.status) {
        fragments.push(`status = @status`);
        params.status = filter.status;
      }
      if (tr.sql) fragments.push(tr.sql);
      const where = joinWhere(fragments);
      const page = buildPageClauses(filter, "started_at");
      const sql = `SELECT ${COLUMNS.join(", ")} FROM episodes ${where} ${page}`;
      return db.prepare<typeof params, RawEpisodeRow>(sql).all(params).map(mapRow);
    },

    count(filter: Omit<EpisodeListFilter, "limit" | "offset"> = {}): number {
      const tr = timeRangeWhere(filter, "started_at");
      const fragments: string[] = [];
      const params: Record<string, unknown> = { ...tr.params };
      if (filter.sessionId) {
        fragments.push(`session_id = @session_id`);
        params.session_id = filter.sessionId;
      }
      if (filter.status) {
        fragments.push(`status = @status`);
        params.status = filter.status;
      }
      if (tr.sql) fragments.push(tr.sql);
      const where = joinWhere(fragments);
      const sql = `SELECT COUNT(*) AS n FROM episodes ${where}`;
      return db.prepare<typeof params, { n: number }>(sql).get(params)?.n ?? 0;
    },
  };
}

interface RawEpisodeRow {
  id: string;
  session_id: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  share_scope: string;
  started_at: number;
  ended_at: number | null;
  trace_ids_json: string;
  r_task: number | null;
  verifier_passed: number | null;
  outcome: string | null;
  status: "open" | "closed";
  meta_json: string;
}

function triStateToDb(v: boolean | null | undefined): number | null {
  if (v == null) return null;
  return v ? 1 : 0;
}

function mapRow(r: RawEpisodeRow): EpisodeRow & EpisodeMetaRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    ...ownerFieldsFromRaw(r),
    share: { scope: normalizeShareForStorage(r.share_scope) },
    startedAt: r.started_at,
    endedAt: r.ended_at,
    traceIds: fromJsonText<string[]>(r.trace_ids_json, []),
    rTask: r.r_task,
    verifierPassed:
      r.verifier_passed == null ? null : Boolean(r.verifier_passed),
    outcome: (r.outcome ?? null) as EpisodeRow["outcome"],
    status: r.status,
    meta: fromJsonText<Record<string, unknown>>(r.meta_json, {}),
  };
}
