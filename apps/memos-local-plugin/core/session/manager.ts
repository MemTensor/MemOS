/**
 * `SessionManager` — the only surface adapters and the orchestrator see.
 *
 * Responsibilities:
 *   - Open / close sessions. A session is the long-lived logical
 *     connection between an agent and this plugin.
 *   - Start episodes (classifies intent, writes the row, emits events).
 *   - Add turns to the currently-open episode for a session.
 *   - Finalize / abandon episodes.
 *   - Prune idle sessions / force-close open episodes on shutdown.
 *   - Provide small readers for the viewer (listSessions, listEpisodes).
 *
 * The manager is per-process. There is no distributed coordination —
 * OpenClaw / Hermes run one plugin instance at a time.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { AgentKind, EpisodeId, SessionId } from "../../agent-contract/dto.js";
import { ids } from "../id.js";
import { withCtx } from "../logger/context.js";
import { rootLogger } from "../logger/index.js";
import type { EpochMs } from "../types.js";
import { createEpisodeManager, type EpisodeManager } from "./episode-manager.js";
import { createSessionEventBus } from "./events.js";
import type { IntentClassifier } from "./intent-classifier.js";
import type { EpisodesRepo, SessionRepo } from "./persistence.js";
import type {
  EpisodeFinalizeInput,
  EpisodeSnapshot,
  EpisodeStartInput,
  EpisodeTurn,
  IntentDecision,
  SessionEventBus,
  SessionOpenInput,
  SessionSnapshot,
} from "./types.js";

export interface SessionManagerDeps {
  sessionsRepo: SessionRepo;
  episodesRepo: EpisodesRepo;
  intentClassifier: IntentClassifier;
  now?: () => EpochMs;
  /** Idle cutoff in ms. Used by `pruneIdle`. Default 24h. */
  idleCutoffMs?: number;
  /** Injected bus (for tests) or new if absent. */
  bus?: SessionEventBus;
  /** Injected episode manager (for tests). */
  episodeManager?: EpisodeManager;
}

export interface StartEpisodeInput {
  sessionId: SessionId;
  /** Pre-minted id. Optional. */
  id?: EpisodeId;
  /** First user message. Required. */
  userMessage: string;
  meta?: Record<string, unknown>;
}

export interface SessionManager {
  readonly bus: SessionEventBus;

  openSession(input: SessionOpenInput): SessionSnapshot;
  closeSession(id: SessionId, reason?: string): void;
  getSession(id: SessionId): SessionSnapshot | null;
  listSessions(limit?: number): SessionSnapshot[];
  pruneIdle(now?: EpochMs): SessionId[];

  startEpisode(input: StartEpisodeInput): Promise<EpisodeSnapshot>;
  addTurn(episodeId: EpisodeId, turn: Omit<EpisodeTurn, "id" | "ts">): EpisodeTurn;
  finalizeEpisode(episodeId: EpisodeId, input?: EpisodeFinalizeInput): EpisodeSnapshot;
  abandonEpisode(episodeId: EpisodeId, reason: string): EpisodeSnapshot;
  /** V7 §0.1 "revision" path — reopen a previously-closed episode. */
  reopenEpisode(
    episodeId: EpisodeId,
    reason: import("./types.js").TurnRelation,
  ): EpisodeSnapshot;
  attachTraceIds(episodeId: EpisodeId, traceIds: string[]): void;

  getEpisode(id: EpisodeId): EpisodeSnapshot | null;
  listEpisodes(sessionId: SessionId): EpisodeSnapshot[];
  listOpenEpisodes(): EpisodeSnapshot[];

  /** Shutdown path. Abandons any open episodes and closes all sessions. */
  shutdown(reason: string): void;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const now = deps.now ?? Date.now;
  const log = rootLogger.child({ channel: "core.session" });
  const bus = deps.bus ?? createSessionEventBus();
  const epm = deps.episodeManager ?? createEpisodeManager({
    sessionsRepo: deps.sessionsRepo,
    episodesRepo: deps.episodesRepo,
    now,
    bus,
  });

  // Known-alive sessions (includes ones we've only seen via touch / DB row
  // reloads). Populated on demand in `getSession` too.
  const live = new Map<SessionId, SessionSnapshot>();

  function snapshotFor(row: ReturnType<SessionRepo["getById"]> & object): SessionSnapshot {
    return {
      id: row.id,
      agent: row.agent,
      startedAt: row.startedAt,
      lastSeenAt: row.lastSeenAt,
      meta: row.meta,
      openEpisodeCount: epm.listForSession(row.id).filter((e) => e.status === "open").length,
    };
  }

  function openSession(input: SessionOpenInput): SessionSnapshot {
    const ts = now();
    const id = input.id ?? (ids.session() as SessionId);
    deps.sessionsRepo.upsertIfMissing({
      id,
      agent: input.agent,
      startedAt: ts,
      lastSeenAt: ts,
      meta: input.meta ?? {},
    });
    const row = deps.sessionsRepo.getById(id);
    if (!row) {
      throw new MemosError(ERROR_CODES.INTERNAL, "sessions.upsert inserted row but getById returned null", {
        sessionId: id,
      });
    }
    const snap = snapshotFor(row);
    live.set(id, snap);
    log.info("session.opened", {
      sessionId: id,
      agent: input.agent,
      startedAt: row.startedAt,
      new: row.startedAt === ts,
    });
    bus.emit({ kind: "session.started", session: snap });
    return { ...snap };
  }

  function closeSession(id: SessionId, reason = "explicit"): void {
    for (const ep of epm.listForSession(id)) {
      if (ep.status !== "open") continue;
      // V7 §0.2 — a user-initiated session close (`/new`, `/quit`, the
      // host shutting down cleanly) is **normal lifecycle**, NOT
      // episode abandonment. Finalize the episode so the capture +
      // reward pipelines run as if the user had completed their task:
      //
      //   - substantial conversations get LLM-scored → "已完成" badge
      //   - trivial / single-turn episodes get re-stamped to
      //     `closeReason="abandoned"` by reward.ts itself with a clear
      //     human-readable `abandonReason` ("对话轮次不足，N 轮…")
      //
      // Crucially, this keeps the technical `session_closed:client`
      // string out of the user-facing TasksView "已跳过" badge — that
      // string was the source of the "为什么 /new 后立刻显示已跳过"
      // confusion. True crash-orphans get a separate recovery path
      // at plugin bootstrap (see `recoverOrphanedEpisodes` in
      // `core/pipeline/memory-core.ts`).
      epm.finalize(ep.id, {
        patchMeta: { sessionCloseReason: reason },
      });
    }
    live.delete(id);
    log.info("session.closed", { sessionId: id, reason });
    bus.emit({ kind: "session.closed", sessionId: id, reason });
  }

  function getSession(id: SessionId): SessionSnapshot | null {
    const cached = live.get(id);
    if (cached) return { ...cached };
    const row = deps.sessionsRepo.getById(id);
    if (!row) return null;
    const snap = snapshotFor(row);
    live.set(id, snap);
    return { ...snap };
  }

  function listSessions(limit = 50): SessionSnapshot[] {
    return deps.sessionsRepo.listRecent(limit).map((r) => snapshotFor(r));
  }

  function pruneIdle(nowTs: EpochMs = now()): SessionId[] {
    const cutoff = nowTs - (deps.idleCutoffMs ?? 24 * 60 * 60 * 1000);
    const stale: SessionId[] = [];
    for (const [id, snap] of live.entries()) {
      if (snap.lastSeenAt < cutoff) {
        const openEps = epm.listForSession(id).filter((e) => e.status === "open");
        if (openEps.length > 0) continue; // don't evict while we're mid-episode
        stale.push(id);
      }
    }
    for (const id of stale) {
      live.delete(id);
      bus.emit({ kind: "session.idle_pruned", sessionId: id, idleMs: nowTs - (getSession(id)?.lastSeenAt ?? nowTs) });
    }
    if (stale.length > 0) log.info("session.pruned", { count: stale.length });
    return stale;
  }

  async function startEpisode(input: StartEpisodeInput): Promise<EpisodeSnapshot> {
    const session = getSession(input.sessionId);
    if (!session) {
      throw new MemosError(ERROR_CODES.SESSION_NOT_FOUND, `session ${input.sessionId} not found`, {
        sessionId: input.sessionId,
      });
    }

    const intent = await deps.intentClassifier.classify(input.userMessage);
    const episodeId = (input.id ?? ids.episode()) as EpisodeId;

    // Wrap the write+emit in a log context so downstream listeners inherit
    // the correlation ids without having to know them.
    return withCtx(
      { sessionId: input.sessionId, episodeId },
      () => {
        const startInput: EpisodeStartInput = {
          sessionId: input.sessionId,
          id: episodeId,
          initialTurn: { role: "user", content: input.userMessage, meta: input.meta },
          meta: input.meta,
        };
        const snap = epm.start(startInput, intent);
        // Update cached open count.
        const cached = live.get(input.sessionId);
        if (cached) cached.openEpisodeCount++;
        log.info("episode.begun", {
          episodeId,
          sessionId: input.sessionId,
          intent: intent.kind,
          intentConfidence: intent.confidence,
          retrieval: intent.retrieval,
        });
        return snap;
      },
    );
  }

  function decrementOpenCount(sessionId: SessionId): void {
    const cached = live.get(sessionId);
    if (cached && cached.openEpisodeCount > 0) cached.openEpisodeCount--;
  }

  function finalizeEpisode(id: EpisodeId, input?: EpisodeFinalizeInput): EpisodeSnapshot {
    const snap = epm.finalize(id, input);
    decrementOpenCount(snap.sessionId);
    return snap;
  }

  function abandonEpisode(id: EpisodeId, reason: string): EpisodeSnapshot {
    const snap = epm.abandon(id, reason);
    decrementOpenCount(snap.sessionId);
    return snap;
  }

  function reopenEpisode(
    id: EpisodeId,
    reason: import("./types.js").TurnRelation,
  ): EpisodeSnapshot {
    const before = epm.get(id);
    const snap = epm.reopen(id, reason);
    // If we reopened a closed one, bump the open count back up.
    if (before && before.status === "closed" && snap.status === "open") {
      const cached = live.get(snap.sessionId);
      if (cached) cached.openEpisodeCount++;
    }
    return snap;
  }

  function shutdown(reason: string): void {
    log.info("shutdown.begin", { reason });
    // Process-wide shutdown is normal lifecycle (host stopping cleanly,
    // not a crash) — same semantics as `closeSession`. Finalize open
    // episodes via the same code path so they don't get the ugly
    // `closeReason="abandoned"` + `abandonReason="shutdown:..."` badge
    // that used to confuse users reading the Tasks list.
    //
    // First catch episodes whose session was already pruned from
    // `live` (race: idle prune → process exit). closeSession's per-
    // session loop wouldn't find them otherwise.
    for (const ep of epm.listOpen()) {
      if (!live.has(ep.sessionId)) {
        finalizeEpisode(ep.id, {
          patchMeta: { sessionCloseReason: `shutdown:${reason}` },
        });
      }
    }
    // Then close every still-live session — closeSession's loop
    // finalizes any remaining open episodes.
    for (const id of Array.from(live.keys())) {
      closeSession(id, `shutdown:${reason}`);
    }
    log.info("shutdown.done", { reason });
  }

  return {
    bus,
    openSession,
    closeSession,
    getSession,
    listSessions,
    pruneIdle,

    startEpisode,
    addTurn: epm.addTurn,
    finalizeEpisode,
    abandonEpisode,
    reopenEpisode,
    attachTraceIds: epm.attachTraceIds,

    getEpisode: epm.get,
    listEpisodes: epm.listForSession,
    listOpenEpisodes: epm.listOpen,

    shutdown,
  };
}

// Re-export helpers tests will want to use.
export type { IntentDecision } from "./types.js";
export type { AgentKind };
