/**
 * In-memory fakes for SessionRepo / EpisodesRepo.
 *
 * Shared by several tests under tests/unit/session/. Each one starts fresh.
 */

import type { AgentKind, EpisodeId, SessionId } from "../../../agent-contract/dto.js";
import type { EpisodesRepo, SessionRepo } from "../../../core/session/persistence.js";

export interface CapturedSession {
  id: SessionId;
  agent: AgentKind;
  startedAt: number;
  lastSeenAt: number;
  meta: Record<string, unknown>;
}

export interface CapturedEpisode {
  id: EpisodeId;
  sessionId: SessionId;
  startedAt: number;
  endedAt: number | null;
  traceIds: string[];
  rTask: number | null;
  status: "open" | "closed";
  meta: Record<string, unknown>;
}

export function makeInMemorySessionRepo(): {
  repo: SessionRepo;
  rows: Map<SessionId, CapturedSession>;
} {
  const rows = new Map<SessionId, CapturedSession>();
  const repo: SessionRepo = {
    upsertIfMissing(row) {
      if (rows.has(row.id)) return;
      rows.set(row.id, { ...row });
    },
    touchLastSeen(id, ts, metaPatch) {
      const cur = rows.get(id);
      if (!cur) return;
      cur.lastSeenAt = ts;
      if (metaPatch) cur.meta = { ...cur.meta, ...metaPatch };
    },
    getById(id) {
      return rows.get(id) ?? null;
    },
    listRecent(limit = 50) {
      return Array.from(rows.values())
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(0, limit);
    },
    deleteOlderThan(cutoff) {
      let n = 0;
      for (const [id, row] of rows) {
        if (row.lastSeenAt < cutoff) {
          rows.delete(id);
          n++;
        }
      }
      return n;
    },
  };
  return { repo, rows };
}

export function makeInMemoryEpisodesRepo(): {
  repo: EpisodesRepo;
  rows: Map<EpisodeId, CapturedEpisode>;
} {
  const rows = new Map<EpisodeId, CapturedEpisode>();
  const repo: EpisodesRepo = {
    insert(row) {
      rows.set(row.id, { ...row });
    },
    updateTraceIds(id, traceIds) {
      const cur = rows.get(id);
      if (cur) cur.traceIds = [...traceIds];
    },
    close(id, endedAt, rTask, meta) {
      const cur = rows.get(id);
      if (!cur) return;
      cur.endedAt = endedAt;
      cur.status = "closed";
      if (rTask !== undefined) cur.rTask = rTask;
      if (meta) cur.meta = { ...cur.meta, ...meta };
    },
    reopen(id, meta) {
      const cur = rows.get(id);
      if (!cur) return;
      cur.endedAt = null;
      cur.status = "open";
      if (meta) cur.meta = { ...cur.meta, ...meta };
    },
    getById(id) {
      return rows.get(id) ?? null;
    },
    getOpenForSession(sessionId) {
      for (const row of rows.values()) {
        if (row.sessionId === sessionId && row.status === "open") return row;
      }
      return null;
    },
  };
  return { repo, rows };
}
