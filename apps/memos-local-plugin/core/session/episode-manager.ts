/**
 * `EpisodeManager` — the write-path to `episodes` + `sessions`, wrapped
 * around per-episode in-memory state.
 *
 * Not visible to adapters directly — `SessionManager` wraps it and owns
 * the lifecycle. Exposed separately so Phase 15 (pipeline orchestrator)
 * can inject a custom one in tests.
 *
 * Persistence strategy:
 *   - `start`     → INSERT episodes row (status='open'), INSERT/UPSERT sessions.
 *   - `addTurn`   → in-memory only (turns persist via `traces` in Phase 6).
 *   - `finalize`  → UPDATE episodes.status='closed', endedAt, rTask.
 *   - `abandon`   → same UPDATE but tagged via meta.closeReason='abandoned'.
 *
 * The in-memory `EpisodeSnapshot` is what subscribers (orchestrator,
 * viewer SSE) receive on every event. We avoid re-reading from SQLite
 * on each turn — hot path stays in memory.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { EpisodeId, SessionId } from "../../agent-contract/dto.js";
import { ids } from "../id.js";
import { rootLogger } from "../logger/index.js";
import type { EpochMs } from "../types.js";
import type { SessionRepo, EpisodesRepo } from "./persistence.js";
import type {
  EpisodeCloseReason,
  EpisodeFinalizeInput,
  EpisodeSnapshot,
  EpisodeStartInput,
  EpisodeTurn,
  IntentDecision,
  SessionEventBus,
} from "./types.js";

export interface EpisodeManagerDeps {
  sessionsRepo: SessionRepo;
  episodesRepo: EpisodesRepo;
  now?: () => EpochMs;
  bus: SessionEventBus;
}

export interface EpisodeManager {
  start(input: EpisodeStartInput, intent: IntentDecision): EpisodeSnapshot;
  addTurn(id: EpisodeId, turn: Omit<EpisodeTurn, "id" | "ts">): EpisodeTurn;
  finalize(id: EpisodeId, input?: EpisodeFinalizeInput): EpisodeSnapshot;
  abandon(id: EpisodeId, reason: string): EpisodeSnapshot;
  attachTraceIds(id: EpisodeId, traceIds: string[]): void;
  /**
   * V7 §0.1 "revision" path: reopen a previously-finalized episode so
   * the new turn appends to the same trace set. The caller is
   * responsible for having classified the turn relation; this method
   * performs no heuristics of its own.
   *
   * Emits `episode.reopened` with the given `reason`. If the episode
   * is already open (rare — race), this is a no-op.
   */
  reopen(id: EpisodeId, reason: import("./types.js").TurnRelation): EpisodeSnapshot;

  get(id: EpisodeId): EpisodeSnapshot | null;
  listOpen(): EpisodeSnapshot[];
  listForSession(sessionId: SessionId): EpisodeSnapshot[];
}

export function createEpisodeManager(deps: EpisodeManagerDeps): EpisodeManager {
  const now = deps.now ?? Date.now;
  const log = rootLogger.child({ channel: "core.episode" });
  // id → snapshot; we keep both open and recently-closed ones for short-term
  // lookups. The snapshot is evicted after `finalize`/`abandon` unless an
  // orchestrator is still holding a reference.
  const byId = new Map<EpisodeId, EpisodeSnapshot>();

  function get(id: EpisodeId): EpisodeSnapshot | null {
    return byId.get(id) ?? null;
  }

  function assertOpen(snap: EpisodeSnapshot | null, id: EpisodeId): EpisodeSnapshot {
    if (!snap) {
      throw new MemosError(ERROR_CODES.EPISODE_NOT_FOUND, `episode ${id} not found`, {
        episodeId: id,
      });
    }
    if (snap.status === "closed") {
      throw new MemosError(ERROR_CODES.CONFLICT, `episode ${id} already closed`, {
        episodeId: id,
        status: snap.status,
      });
    }
    return snap;
  }

  return {
    start(input: EpisodeStartInput, intent: IntentDecision): EpisodeSnapshot {
      if (!input.initialTurn || !input.initialTurn.content) {
        throw new MemosError(
          ERROR_CODES.INVALID_ARGUMENT,
          "episode.start requires an initial user turn with non-empty content",
        );
      }
      const startedAt = now();
      const id = (input.id ?? ids.episode()) as EpisodeId;
      const firstTurn: EpisodeTurn = {
        ...input.initialTurn,
        id: ids.span(),
        ts: startedAt,
      };
      const snap: EpisodeSnapshot = {
        id,
        sessionId: input.sessionId,
        startedAt,
        endedAt: null,
        status: "open",
        rTask: null,
        turnCount: 1,
        turns: [firstTurn],
        traceIds: [],
        meta: { ...(input.meta ?? {}), intent: { kind: intent.kind, signals: intent.signals } },
        intent,
      };
      byId.set(id, snap);
      deps.episodesRepo.insert({
        id,
        sessionId: input.sessionId,
        startedAt,
        endedAt: null,
        traceIds: [],
        rTask: null,
        status: "open",
        meta: snap.meta,
      });
      // `sessions.touch` so last_seen updates on every new episode.
      deps.sessionsRepo.touchLastSeen(input.sessionId, startedAt);
      log.info("episode.started", {
        episodeId: id,
        sessionId: input.sessionId,
        intent: intent.kind,
        retrieval: intent.retrieval,
      });
      deps.bus.emit({ kind: "episode.started", episode: cloneSnapshot(snap) });
      return cloneSnapshot(snap);
    },

    addTurn(id, turn) {
      const snap = assertOpen(get(id), id);
      const full: EpisodeTurn = { ...turn, id: ids.span(), ts: now() };
      snap.turns.push(full);
      snap.turnCount++;
      deps.sessionsRepo.touchLastSeen(snap.sessionId, full.ts);
      log.debug("episode.turn_added", {
        episodeId: id,
        role: turn.role,
        turnCount: snap.turnCount,
      });
      deps.bus.emit({ kind: "episode.turn_added", episodeId: id, turn: full });
      return { ...full };
    },

    attachTraceIds(id, traceIds) {
      const snap = get(id);
      if (!snap) {
        throw new MemosError(ERROR_CODES.EPISODE_NOT_FOUND, `episode ${id} not found`, {
          episodeId: id,
        });
      }
      if (traceIds.length === 0) return;
      snap.traceIds = [...snap.traceIds, ...traceIds];
      deps.episodesRepo.updateTraceIds(id, snap.traceIds);
    },

    finalize(id, input) {
      const snap = assertOpen(get(id), id);
      const endedAt = now();
      snap.status = "closed";
      snap.endedAt = endedAt;
      if (input?.rTask !== undefined) snap.rTask = input.rTask;
      if (input?.patchMeta) snap.meta = { ...snap.meta, ...input.patchMeta };
      snap.meta = { ...snap.meta, closeReason: "finalized" };
      deps.episodesRepo.close(id, endedAt, snap.rTask ?? undefined, snap.meta);
      log.info("episode.finalized", {
        episodeId: id,
        sessionId: snap.sessionId,
        turnCount: snap.turnCount,
        durationMs: endedAt - snap.startedAt,
        rTask: snap.rTask,
      });
      deps.bus.emit({ kind: "episode.finalized", episode: cloneSnapshot(snap), closedBy: "finalized" });
      return cloneSnapshot(snap);
    },

    abandon(id, reason) {
      const snap = get(id);
      if (!snap) {
        throw new MemosError(ERROR_CODES.EPISODE_NOT_FOUND, `episode ${id} not found`, {
          episodeId: id,
        });
      }
      if (snap.status === "closed") {
        return cloneSnapshot(snap);
      }
      const endedAt = now();
      snap.status = "closed";
      snap.endedAt = endedAt;
      const hasReward = snap.rTask != null;
      if (hasReward) {
        snap.meta = { ...snap.meta, closeReason: "finalized", abandonReason: undefined };
        log.info("episode.abandon_finalized", {
          episodeId: id,
          sessionId: snap.sessionId,
          turnCount: snap.turnCount,
          rTask: snap.rTask,
          reason,
        });
      } else {
        snap.meta = { ...snap.meta, closeReason: "abandoned", abandonReason: reason };
        log.warn("episode.abandoned", {
          episodeId: id,
          sessionId: snap.sessionId,
          turnCount: snap.turnCount,
          reason,
        });
      }
      deps.episodesRepo.close(id, endedAt, snap.rTask ?? undefined, snap.meta);
      deps.bus.emit({ kind: "episode.finalized", episode: cloneSnapshot(snap), closedBy: hasReward ? "finalized" : "abandoned" });
      if (!hasReward) {
        deps.bus.emit({ kind: "episode.abandoned", episodeId: id, reason });
      }
      return cloneSnapshot(snap);
    },

    reopen(id, reason) {
      const snap = get(id);
      if (!snap) {
        throw new MemosError(ERROR_CODES.EPISODE_NOT_FOUND, `episode ${id} not found`, {
          episodeId: id,
        });
      }
      if (snap.status === "open") {
        // Already open — no-op; still surface the intent for audit.
        log.debug("episode.reopen_skipped", { episodeId: id, reason });
        return cloneSnapshot(snap);
      }
      snap.status = "open";
      snap.endedAt = null;
      snap.meta = {
        ...snap.meta,
        closeReason: undefined,
        reopenedAt: now(),
        reopenReason: reason,
      };
      deps.episodesRepo.reopen(id, snap.meta);
      log.info("episode.reopened", {
        episodeId: id,
        sessionId: snap.sessionId,
        reason,
        turnCount: snap.turnCount,
      });
      deps.bus.emit({ kind: "episode.reopened", episode: cloneSnapshot(snap), reason });
      return cloneSnapshot(snap);
    },

    get(id) {
      const s = get(id);
      return s ? cloneSnapshot(s) : null;
    },

    listOpen() {
      const out: EpisodeSnapshot[] = [];
      for (const s of byId.values()) if (s.status === "open") out.push(cloneSnapshot(s));
      return out;
    },

    listForSession(sessionId) {
      const out: EpisodeSnapshot[] = [];
      for (const s of byId.values()) if (s.sessionId === sessionId) out.push(cloneSnapshot(s));
      return out;
    },
  };
}

function cloneSnapshot(s: EpisodeSnapshot): EpisodeSnapshot {
  return {
    ...s,
    turns: s.turns.map((t) => ({ ...t })),
    traceIds: [...s.traceIds],
    meta: { ...s.meta },
  };
}
