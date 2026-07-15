/**
 * Session rows are lightweight: we only track birth/last-seen + a JSON meta
 * bag for whatever adapters want to stash (e.g. OpenClaw's `hostPid`).
 */

import type { AgentKind, SessionId } from "../../types.js";
import type { StorageDb } from "../types.js";
import { buildInsert, buildUpdate } from "../tx.js";
import { fromJsonText, ownerFieldsFromRaw, ownerParamsFromRow, toJsonText } from "./_helpers.js";

export interface SessionRow {
  id: SessionId;
  agent: AgentKind;
  ownerAgentKind?: AgentKind;
  ownerProfileId?: string;
  ownerWorkspaceId?: string | null;
  startedAt: number;
  lastSeenAt: number;
  meta: Record<string, unknown>;
}

const COLUMNS = [
  "id",
  "agent",
  "owner_agent_kind",
  "owner_profile_id",
  "owner_workspace_id",
  "started_at",
  "last_seen_at",
  "meta_json",
];

export function makeSessionsRepo(db: StorageDb) {
  const insert = db.prepare(
    buildInsert({ table: "sessions", columns: COLUMNS, onConflict: "replace" }),
  );
  const update = db.prepare(
    buildUpdate({ table: "sessions", columns: ["id", "last_seen_at", "meta_json"] }),
  );
  const selectById = db.prepare<{ id: string }, RawSessionRow>(
    `SELECT ${COLUMNS.join(", ")} FROM sessions WHERE id=@id`,
  );
  const selectRecent = db.prepare<{ limit: number }, RawSessionRow>(
    `SELECT ${COLUMNS.join(", ")} FROM sessions ORDER BY last_seen_at DESC LIMIT @limit`,
  );
  const deleteOlderThan = db.prepare<{ cutoff: number }>(
    `DELETE FROM sessions WHERE last_seen_at < @cutoff`,
  );

  return {
    upsert(row: SessionRow): void {
      insert.run({
        id: row.id,
        agent: row.agent,
        ...ownerParamsFromRow(row),
        started_at: row.startedAt,
        last_seen_at: row.lastSeenAt,
        meta_json: toJsonText(row.meta ?? {}),
      });
    },

    touch(id: SessionId, lastSeenAt: number, meta?: Record<string, unknown>): void {
      update.run({
        id,
        last_seen_at: lastSeenAt,
        meta_json: toJsonText(meta ?? {}),
      });
    },

    getById(id: SessionId): SessionRow | null {
      const r = selectById.get({ id });
      if (!r) return null;
      return mapRow(r);
    },

    listRecent(limit = 50): SessionRow[] {
      return selectRecent.all({ limit }).map(mapRow);
    },

    deleteOlderThan(cutoffMs: number): number {
      const r = deleteOlderThan.run({ cutoff: cutoffMs });
      return r.changes;
    },
  };
}

// ─── internal ────────────────────────────────────────────────────────────────

interface RawSessionRow {
  id: string;
  agent: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  started_at: number;
  last_seen_at: number;
  meta_json: string;
}

function mapRow(r: RawSessionRow): SessionRow {
  return {
    id: r.id,
    agent: r.agent,
    ...ownerFieldsFromRaw(r),
    startedAt: r.started_at,
    lastSeenAt: r.last_seen_at,
    meta: fromJsonText<Record<string, unknown>>(r.meta_json, {}),
  };
}
