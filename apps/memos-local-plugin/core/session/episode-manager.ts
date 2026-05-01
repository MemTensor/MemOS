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
  EpisodeTurnInput,
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
  addTurn(id: EpisodeId, turn: EpisodeTurnInput): EpisodeTurn;
  finalize(id: EpisodeId, input?: EpisodeFinalizeInput): EpisodeSnapshot;
  abandon(id: EpisodeId, reason: string): EpisodeSnapshot;
  attachTraceIds(id: EpisodeId, traceIds: string[]): void;
  hydrate(snapshot: EpisodeSnapshot): EpisodeSnapshot;
  patchMeta(id: EpisodeId, metaPatch: Record<string, unknown>): EpisodeSnapshot;
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
      const startedAt = input.initialTurn.ts ?? now();
      const id = (input.id ?? ids.episode()) as EpisodeId;
      const firstTurn: EpisodeTurn = {
        ...input.initialTurn,
        id: ids.span(),
        ts: startedAt,
      };
      const meta = {
        ...(input.meta ?? {}),
        topicState: (input.meta ?? {}).topicState ?? "active",
        initialUserText: (input.meta ?? {}).initialUserText ?? input.initialTurn.content,
        pendingUserText: (input.meta ?? {}).pendingUserText ?? input.initialTurn.content,
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
        meta: { ...meta, intent: { kind: intent.kind, signals: intent.signals } },
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
      const full: EpisodeTurn = { ...turn, id: ids.span(), ts: turn.ts ?? now() };
      snap.turns.push(full);
      snap.turnCount++;
      if (turn.role === "user") {
        snap.meta = {
          ...snap.meta,
          topicState: "active",
          pendingUserText: turn.content,
          lastUserText: turn.content,
        };
        deps.episodesRepo.updateMeta(id, {
          topicState: "active",
          pendingUserText: turn.content,
          lastUserText: turn.content,
        });
      } else if (turn.role === "assistant") {
        snap.meta = {
          ...snap.meta,
          topicState: "active",
          pendingUserText: undefined,
          lastAssistantText: turn.content,
        };
        deps.episodesRepo.updateMeta(id, {
          topicState: "active",
          pendingUserText: undefined,
          lastAssistantText: turn.content,
        });
      }
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

    hydrate(snapshot) {
      const existing = byId.get(snapshot.id);
      if (existing) return cloneSnapshot(existing);
      const snap: EpisodeSnapshot = {
        ...snapshot,
        turns: snapshot.turns.map((t) => ({ ...t })),
        traceIds: [...snapshot.traceIds],
        meta: { ...snapshot.meta },
      };
      byId.set(snapshot.id, snap);
      log.info("episode.hydrated", {
        episodeId: snap.id,
        sessionId: snap.sessionId,
        status: snap.status,
        turnCount: snap.turnCount,
      });
      return cloneSnapshot(snap);
    },

    patchMeta(id, metaPatch) {
      const snap = get(id);
      if (!snap) {
        throw new MemosError(ERROR_CODES.EPISODE_NOT_FOUND, `episode ${id} not found`, {
          episodeId: id,
        });
      }
      snap.meta = { ...snap.meta, ...metaPatch };
      deps.episodesRepo.updateMeta(id, metaPatch);
      return cloneSnapshot(snap);
    },

    finalize(id, input) {
      const snap = assertOpen(get(id), id);
      const endedAt = now();
      snap.status = "closed";
      snap.endedAt = endedAt;
      if (input?.rTask !== undefined) snap.rTask = input.rTask;
      if (input?.patchMeta) snap.meta = { ...snap.meta, ...input.patchMeta };
      snap.meta = { ...snap.meta, topicState: "ended", closeReason: "finalized" };
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
      snap.meta = {
        ...snap.meta,
        topicState: "ended",
        closeReason: "abandoned",
        abandonReason: reason,
      };
      deps.episodesRepo.close(id, endedAt, snap.rTask ?? undefined, snap.meta);
      log.warn("episode.abandoned", {
        episodeId: id,
        sessionId: snap.sessionId,
        turnCount: snap.turnCount,
        reason,
      });
      deps.bus.emit({ kind: "episode.finalized", episode: cloneSnapshot(snap), closedBy: "abandoned" });
      deps.bus.emit({ kind: "episode.abandoned", episodeId: id, reason });
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
      const previousReward = snap.rTask != null
        ? {
            previousRTask: snap.rTask,
            previousScoredAt: rewardScoredAt(snap.meta),
          }
        : {};
      snap.meta = {
        ...snap.meta,
        closeReason: undefined,
        topicState: "active",
        reopenedAt: now(),
        reopenReason: reason,
        ...(snap.rTask != null || snap.meta.reward
          ? {
              rewardDirty: {
                reason: "episode_reopened",
                reopenedFor: reason,
                at: now(),
                ...previousReward,
              },
            }
          : {}),
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

function rewardScoredAt(meta: Record<string, unknown>): unknown {
  const reward = meta.reward;
  if (!reward || typeof reward !== "object") return undefined;
  return (reward as { scoredAt?: unknown }).scoredAt;
}

function cloneSnapshot(s: EpisodeSnapshot): EpisodeSnapshot {
  return {
    ...s,
    turns: s.turns.map((t) => ({ ...t })),
    traceIds: [...s.traceIds],
    meta: { ...s.meta },
  };
}
