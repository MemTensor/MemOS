/**
 * Database-side audit log. Every write here is also mirrored to the file-based
 * audit.log sink (`core/logger/sinks/audit-log.ts`). Both are kept forever.
 */

import type { PageOptions, StorageDb } from "../types.js";
import { buildInsert } from "../tx.js";
import { buildPageClauses, fromJsonText, toJsonText } from "./_helpers.js";

export interface AuditEventRow {
  id?: number;
  ts: number;
  actor: string;        // "user" | "system" | "hub:alice" | …
  kind: string;         // "config.update" | "skill.retire" | "hub.join" | …
  target?: string | null;
  detail?: Record<string, unknown>;
}

const COLUMNS = ["ts", "actor", "kind", "target", "detail_json"];

export function makeAuditRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "audit_events", columns: COLUMNS }));
  const selectById = db.prepare<{ id: number }, RawAuditRow>(
    `SELECT id, ts, actor, kind, target, detail_json FROM audit_events WHERE id=@id`,
  );
  const selectKind = db.prepare<{ kind: string; limit: number }, RawAuditRow>(
    `SELECT id, ts, actor, kind, target, detail_json FROM audit_events WHERE kind=@kind ORDER BY ts DESC LIMIT @limit`,
  );

  return {
    append(row: AuditEventRow): number {
      const r = insert.run({
        ts: row.ts,
        actor: row.actor,
        kind: row.kind,
        target: row.target ?? null,
        detail_json: toJsonText(row.detail ?? {}),
      });
      return Number(r.lastInsertRowid);
    },

    getById(id: number): AuditEventRow | null {
      const r = selectById.get({ id });
      return r ? mapRow(r) : null;
    },

    listKind(kind: string, limit = 200): AuditEventRow[] {
      return selectKind.all({ kind, limit }).map(mapRow);
    },

    list(opts: PageOptions = {}): AuditEventRow[] {
      const page = buildPageClauses(opts, "ts");
      const sql = `SELECT id, ts, actor, kind, target, detail_json FROM audit_events ${page}`;
      return db.prepare<unknown, RawAuditRow>(sql).all().map(mapRow);
    },
  };
}

interface RawAuditRow {
  id: number;
  ts: number;
  actor: string;
  kind: string;
  target: string | null;
  detail_json: string;
}

function mapRow(r: RawAuditRow): AuditEventRow {
  return {
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    kind: r.kind,
    target: r.target,
    detail: fromJsonText<Record<string, unknown>>(r.detail_json, {}),
  };
}
