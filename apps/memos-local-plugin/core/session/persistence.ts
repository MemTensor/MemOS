/**
 * Persistence interfaces for `SessionManager` / `EpisodeManager`.
 *
 * The core-facing shape is intentionally thinner than the raw repositories
 * in `core/storage/repos/` — just the operations the session layer needs,
 * with session-friendly signatures. Tests inject in-memory fakes that
 * implement these interfaces without touching SQLite.
 *
 * The concrete `makeStorageBackedAdapters(...)` wires the real repos.
 */

import type { AgentKind, EpisodeId, SessionId } from "../../agent-contract/dto.js";
import type { makeEpisodesRepo, makeSessionsRepo } from "../storage/repos/index.js";
import type { EpochMs } from "../types.js";

export interface SessionRepo {
  upsertIfMissing(row: {
    id: SessionId;
    agent: AgentKind;
    ownerAgentKind?: AgentKind;
    ownerProfileId?: string;
    ownerWorkspaceId?: string | null;
    startedAt: EpochMs;
    lastSeenAt: EpochMs;
    meta: Record<string, unknown>;
  }): void;
  touchLastSeen(id: SessionId, ts: EpochMs, metaPatch?: Record<string, unknown>): void;
  getById(id: SessionId): {
    id: SessionId;
    agent: AgentKind;
    ownerAgentKind?: AgentKind;
    ownerProfileId?: string;
    ownerWorkspaceId?: string | null;
    startedAt: EpochMs;
    lastSeenAt: EpochMs;
    meta: Record<string, unknown>;
  } | null;
  listRecent(limit?: number): Array<{
    id: SessionId;
    agent: AgentKind;
    ownerAgentKind?: AgentKind;
    ownerProfileId?: string;
    ownerWorkspaceId?: string | null;
    startedAt: EpochMs;
    lastSeenAt: EpochMs;
    meta: Record<string, unknown>;
  }>;
  deleteOlderThan(cutoffMs: EpochMs): number;
}

export interface EpisodesRepo {
  insert(row: {
    id: EpisodeId;
    sessionId: SessionId;
    ownerAgentKind?: AgentKind;
    ownerProfileId?: string;
    ownerWorkspaceId?: string | null;
    startedAt: EpochMs;
    endedAt: EpochMs | null;
    traceIds: string[];
    rTask: number | null;
    status: "open" | "closed";
    meta: Record<string, unknown>;
  }): void;
  updateTraceIds(id: EpisodeId, traceIds: string[]): void;
  updateMeta(id: EpisodeId, metaPatch: Record<string, unknown>): void;
  close(id: EpisodeId, endedAt: EpochMs, rTask?: number, meta?: Record<string, unknown>): void;
  /**
   * Flip a closed episode back to `open` — V7 §0.1 "revision" path.
   * Idempotent for already-open episodes.
   */
  reopen(id: EpisodeId, meta?: Record<string, unknown>): void;
  getById(id: EpisodeId): unknown | null;
  getOpenForSession(sessionId: SessionId): unknown | null;
}

// ─── Storage adapter factories (real repos) ─────────────────────────────────

type SqliteSessions = ReturnType<typeof makeSessionsRepo>;
type SqliteEpisodes = ReturnType<typeof makeEpisodesRepo>;

export function adaptSessionsRepo(sqlite: SqliteSessions): SessionRepo {
  return {
    upsertIfMissing(row) {
      const existing = sqlite.getById(row.id);
      if (existing) return;
      sqlite.upsert({
        id: row.id,
        agent: row.agent as AgentKind,
        ownerAgentKind: row.ownerAgentKind,
        ownerProfileId: row.ownerProfileId,
        ownerWorkspaceId: row.ownerWorkspaceId,
        startedAt: row.startedAt,
        lastSeenAt: row.lastSeenAt,
        meta: row.meta,
      });
    },
    touchLastSeen(id, ts, metaPatch) {
      const existing = sqlite.getById(id);
      const nextMeta = { ...(existing?.meta ?? {}), ...(metaPatch ?? {}) };
      sqlite.touch(id, ts, nextMeta);
    },
    getById(id) {
      const r = sqlite.getById(id);
      if (!r) return null;
      return {
        id: r.id,
        agent: r.agent,
        ownerAgentKind: r.ownerAgentKind,
        ownerProfileId: r.ownerProfileId,
        ownerWorkspaceId: r.ownerWorkspaceId,
        startedAt: r.startedAt,
        lastSeenAt: r.lastSeenAt,
        meta: r.meta,
      };
    },
    listRecent(limit = 50) {
      return sqlite.listRecent(limit).map((r) => ({
        id: r.id,
        agent: r.agent,
        ownerAgentKind: r.ownerAgentKind,
        ownerProfileId: r.ownerProfileId,
        ownerWorkspaceId: r.ownerWorkspaceId,
        startedAt: r.startedAt,
        lastSeenAt: r.lastSeenAt,
        meta: r.meta,
      }));
    },
    deleteOlderThan: sqlite.deleteOlderThan,
  };
}

export function adaptEpisodesRepo(sqlite: SqliteEpisodes): EpisodesRepo {
  return {
    insert(row) {
      sqlite.insert({
        id: row.id,
        sessionId: row.sessionId,
        ownerAgentKind: row.ownerAgentKind,
        ownerProfileId: row.ownerProfileId,
        ownerWorkspaceId: row.ownerWorkspaceId,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        traceIds: row.traceIds,
        rTask: row.rTask,
        status: row.status,
        meta: row.meta,
      });
    },
    updateTraceIds(id, traceIds) {
      sqlite.appendTrace(id, traceIds);
    },
    updateMeta(id, metaPatch) {
      sqlite.updateMeta(id, metaPatch);
    },
    close(id, endedAt, rTask, meta) {
      // CRITICAL: never use `episodes.upsert` here. The repo's upsert
      // is `INSERT OR REPLACE`, which SQLite executes as DELETE +
      // INSERT — and `traces.session_id REFERENCES sessions ON DELETE
      // CASCADE` (and `episode_id ON DELETE CASCADE`) means every
      // trace for the affected episode would be silently wiped. We
      // hit exactly that bug when topic-end reflection started writing
      // traces *before* close fired.
      //
      // The whole "close" operation needs to be incremental UPDATEs:
      //   - status / ended_at via `sqlite.close`
      //   - meta_json patched via `sqlite.updateMeta` (no replace)
      sqlite.close(id, endedAt, rTask);
      if (meta) sqlite.updateMeta(id, meta);
    },
    reopen(id, meta) {
      const cur = sqlite.getById(id);
      if (!cur) return;
      // Same hazard as `close` above — flip the status flag with a
      // surgical UPDATE rather than an upsert that would cascade-
      // delete every trace tied to this episode.
      sqlite.reopen(id);
      if (meta) sqlite.updateMeta(id, meta);
    },
    getById: sqlite.getById,
    getOpenForSession: sqlite.getOpenForSession,
  };
}
