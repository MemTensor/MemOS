import type { EpisodeId, EpisodeRow, SessionId } from "../../types.js";
import type { EpisodeListFilter, StorageDb } from "../types.js";
import { buildInsert, buildUpdate } from "../tx.js";
import {
  buildPageClauses,
  fromJsonText,
  joinWhere,
  timeRangeWhere,
  toJsonText,
} from "./_helpers.js";

const COLUMNS = [
  "id",
  "session_id",
  "started_at",
  "ended_at",
  "trace_ids_json",
  "r_task",
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
  const selectOpenForSession = db.prepare<{ session: string }, RawEpisodeRow>(
    `SELECT ${COLUMNS.join(", ")} FROM episodes WHERE session_id=@session AND status='open' ORDER BY started_at DESC LIMIT 1`,
  );

  return {
    insert(row: EpisodeRow & { meta?: Record<string, unknown> }): void {
      insert.run({
        id: row.id,
        session_id: row.sessionId,
        started_at: row.startedAt,
        ended_at: row.endedAt ?? null,
        trace_ids_json: toJsonText(row.traceIds),
        r_task: row.rTask ?? null,
        status: row.status,
        meta_json: toJsonText(row.meta ?? {}),
      });
    },

    upsert(row: EpisodeRow & { meta?: Record<string, unknown> }): void {
      replace.run({
        id: row.id,
        session_id: row.sessionId,
        started_at: row.startedAt,
        ended_at: row.endedAt ?? null,
        trace_ids_json: toJsonText(row.traceIds),
        r_task: row.rTask ?? null,
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

    updateMeta(id: EpisodeId, metaPatch: Record<string, unknown>): void {
      const current = selectById.get({ id });
      if (!current) return;
      const existing = fromJsonText<Record<string, unknown>>(current.meta_json, {});
      const merged = { ...existing, ...metaPatch };
      db.prepare<{ id: string; meta: string }>(
        `UPDATE episodes SET meta_json=@meta WHERE id=@id`,
      ).run({ id, meta: toJsonText(merged) });
    },

    appendTrace(id: EpisodeId, traceIds: string[]): void {
      appendTrace.run({ id, trace_ids_json: toJsonText(traceIds) });
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
  };
}

interface RawEpisodeRow {
  id: string;
  session_id: string;
  started_at: number;
  ended_at: number | null;
  trace_ids_json: string;
  r_task: number | null;
  status: "open" | "closed";
  meta_json: string;
}

function mapRow(r: RawEpisodeRow): EpisodeRow & EpisodeMetaRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    traceIds: fromJsonText<string[]>(r.trace_ids_json, []),
    rTask: r.r_task,
    status: r.status,
    meta: fromJsonText<Record<string, unknown>>(r.meta_json, {}),
  };
}
