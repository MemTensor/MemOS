/**
 * `createPipeline` — the single orchestrator.
 *
 * Responsibilities (V7 §0.2, §0.3, §0.5):
 *
 *   • Maintain the session / episode lifecycle. Each `onTurnStart` opens a
 *     new episode (carrying the intent classifier's decision forward). We
 *     keep the default "one user query = one episode" and leave the
 *     revision-vs-new-task split to a future iteration; today every
 *     assistant response finalizes its episode at `onTurnEnd`, which in
 *     turn kicks off the capture → reward → L2 → L3 → skill chain.
 *
 *   • Own all event buses and aggregate them into a single
 *     `CoreEvent` stream for the facade's `subscribeEvents` surface.
 *
 *   • Provide retrieval entry points for every V7 injection trigger
 *     (`turn_start`, `tool_driven`, `skill_invoke`, `sub_agent`,
 *     `decision_repair`). Packet shape is always the adapter-contract
 *     `InjectionPacket`.
 *
 *   • Forward tool-call outcomes to the feedback subscriber so the
 *     failure burst detector can schedule repairs autonomously.
 *
 * The orchestrator is single-process and holds in-memory references to
 * the current open episode per session. Adapters can still inspect the
 * session manager directly for richer queries.
 */

import { rootLogger } from "../logger/index.js";
import type { Logger } from "../logger/types.js";
import {
  contextHashOf,
  type FeedbackConfig,
} from "../feedback/index.js";
import {
  turnStartRetrieve,
  toolDrivenRetrieve,
  skillInvokeRetrieve,
  subAgentRetrieve,
  repairRetrieve,
} from "../retrieval/retrieve.js";
import type { RetrievalResult } from "../retrieval/types.js";

import {
  buildPipelineBuses,
  buildPipelineSession,
  buildPipelineSubscribers,
  buildRetrievalDeps,
  extractAlgorithmConfig,
  pipelineLogger,
} from "./deps.js";
import type {
  PipelineAlgorithmConfig,
  PipelineBuses,
  PipelineDeps,
  PipelineHandle,
  RecordToolOutcomeInput,
  TurnEndResult,
} from "./types.js";
import { bridgeToCoreEvents } from "./event-bridge.js";
import type {
  AgentKind,
  EpisodeId,
  InjectionPacket,
  RepairCtx,
  SessionId,
  TraceId,
  ToolDrivenCtx,
  TurnInputDTO,
  TurnResultDTO,
} from "../../agent-contract/dto.js";
import type {
  SkillInvokeCtx,
  SubAgentCtx,
} from "../retrieval/types.js";
import type { CoreEvent } from "../../agent-contract/events.js";
import type { LogRecord } from "../../agent-contract/log-record.js";
import { memoryBuffer } from "../logger/index.js";
import { onBroadcastLog } from "../logger/transports/sse-broadcast.js";
import { createEmbeddingRetryWorker, systemErrorEvent } from "../embedding/index.js";
import type { EpisodeSnapshot } from "../session/index.js";

// ─── Factory ──────────────────────────────────────────────────────────────

export function createPipeline(deps: PipelineDeps): PipelineHandle {
  const log = pipelineLogger(deps);
  const algorithm = extractAlgorithmConfig(deps);
  const buses = buildPipelineBuses();

  // Session + intent.
  const session = buildPipelineSession(deps, buses.session);

  // Algorithm subscribers (capture → reward → L2 → L3 → skill + feedback).
  // Pass `session` so the reward runner's `getEpisodeSnapshot` hook
  // can resolve the live, in-memory episode (with turns populated)
  // rather than falling back to the empty row from SQLite.
  const subs = buildPipelineSubscribers(deps, buses, algorithm, session);

  // Core-event aggregator. Every internal bus funnels into one stream.
  const eventListeners = new Set<(e: CoreEvent) => void>();
  const logListeners = new Set<(r: LogRecord) => void>();

  // Small ring buffer of the most-recent events. Late-connecting SSE
  // subscribers (e.g. the viewer's Overview panel opened after an agent
  // turn already fired) replay this buffer on connect so the "实时活动"
  // card isn't empty by default. 100 rows is plenty — the viewer only
  // renders the last dozen.
  const RECENT_EVENTS_CAP = 100;
  const recentEvents: CoreEvent[] = [];

  const emitCore = (evt: CoreEvent): void => {
    recentEvents.push(evt);
    if (recentEvents.length > RECENT_EVENTS_CAP) {
      recentEvents.splice(0, recentEvents.length - RECENT_EVENTS_CAP);
    }
    if (eventListeners.size === 0) return;
    for (const listener of eventListeners) {
      try {
        listener(evt);
      } catch (err) {
        log.warn("event.listener_threw", {
          type: evt.type,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const getRecentEvents = (): readonly CoreEvent[] =>
    recentEvents.slice();

  let retryEventSeq = 1_000_000;
  const embeddingRetryWorker = createEmbeddingRetryWorker({
    repos: deps.repos,
    embedder: deps.embedder,
    log: log.child({ channel: "core.embedding.retry" }),
    now: deps.now,
    onSystemError: (payload, correlationId) => {
      emitCore(systemErrorEvent(payload, retryEventSeq++, correlationId));
    },
  });
  embeddingRetryWorker.start();

  // Hydrate the ring buffer with synthetic events derived from the
  // most-recent rows on disk. Without this, every plugin restart
  // produces an empty "实时活动" panel until the user happens to
  // interact with the agent again — misleading, because the DB
  // clearly has recent activity. We emit a small set of low-cost
  // synthetic `episode.closed` + `trace.created` entries (no bus
  // fan-out) just for the buffer, so SSE connects replay them to new
  // clients. Seq numbers are monotone from 0 so the frontend's
  // `key={evt.seq}` stays unique against live events that come later.
  try {
    const recentEpisodes = deps.repos.episodes.list({ limit: 20 });
    let seq = 0;
    for (const ep of recentEpisodes.reverse()) {
      const ts = ep.endedAt ?? ep.startedAt;
      if (!ts) continue;
      const type = ep.status === "closed" ? "episode.closed" : "episode.opened";
      recentEvents.push({
        type,
        ts,
        seq: seq++,
        correlationId: ep.id,
        payload: {
          episodeId: ep.id,
          sessionId: ep.sessionId,
          status: ep.status,
          rTask: ep.rTask ?? null,
        },
      });
    }
    if (recentEvents.length > RECENT_EVENTS_CAP) {
      recentEvents.splice(0, recentEvents.length - RECENT_EVENTS_CAP);
    }
    log.debug("events.ring.hydrated", {
      count: recentEvents.length,
      source: "episodes",
    });
  } catch (err) {
    log.debug("events.ring.hydrate_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const bridge = bridgeToCoreEvents({
    buses,
    agent: deps.agent,
    log,
    emit: emitCore,
  });

  // In-memory index of the open episode per session so we can route
  // `addTurn` calls without a repo round-trip.
  const openEpisodeBySession = new Map<SessionId, EpisodeId>();

  // Track the most-recently-closed episode per session so V7 §0.1
  // "revision" can reopen it. Cleared on `new_task`.
  const lastEpisodeBySession = new Map<
    SessionId,
    { episodeId: EpisodeId; endedAt: number; userText: string; assistantText: string }
  >();

  // Track last-seen user-text per session for failure-burst context hashing
  // when the adapter doesn't pass its own.
  const lastUserTextBySession = new Map<SessionId, string>();

  // When a session is closed (e.g. adapter fires `session_end`), purge
  // every orchestrator-local map entry for that session. Without this,
  // `openEpisodeIfNeeded` would still see the stale `lastEpisodeBySession`
  // entry and could reopen an already-abandoned episode the next time the
  // same `bridgeSessionId` is reused — producing the "skipped → active"
  // flip the viewer showed after `/new`.
  buses.session.on("session.closed", (evt) => {
    if (evt.kind !== "session.closed") return;
    const sid = evt.sessionId as SessionId;
    openEpisodeBySession.delete(sid);
    lastEpisodeBySession.delete(sid);
    lastUserTextBySession.delete(sid);
    log.debug("session.maps_cleared", { sessionId: sid, reason: evt.reason });
  });

  // ─── session/episode helpers ────────────────────────────────────────────

  async function ensureSession(
    agent: AgentKind,
    sessionId?: SessionId,
    meta?: Record<string, unknown>,
  ): Promise<SessionId> {
    if (sessionId && session.sessionManager.getSession(sessionId)) {
      if (meta && Object.keys(meta).length > 0) {
        session.sessionManager.openSession({ id: sessionId, agent, meta });
      }
      return sessionId;
    }
    const snap = session.sessionManager.openSession({
      id: sessionId,
      agent,
      meta: meta ?? {},
    });
    return snap.id as SessionId;
  }

  /**
   * Decide whether the new turn continues the current episode, opens a
   * new episode in the same session, or requires a brand-new session.
   *
   * V7 §0.1 routing — under the new "topic-end reflection" architecture
   * episodes are no longer auto-finalized after every turn. So this
   * function takes on the additional responsibility of recognising
   * topic boundaries and finalizing the open episode at the right
   * moment (which in turn fires the topic-level batch reflection).
   *
   * Decision tree:
   *
   *   1. There IS an open episode for this session (the common case):
   *      a. Classify the new user turn against the open episode's
   *         own most recent user/assistant text.
   *      b. revision / follow_up / unknown within `mergeMaxGapMs`
   *         → keep appending to the open episode.
   *      c. new_task OR gap > mergeMaxGapMs OR (episode_per_turn mode)
   *         → `finalizeEpisode(open)` (triggers `runReflect` →
   *         R_human + V backprop), then start a fresh one.
   *
   *   2. No open episode but a recently-finalized one in
   *      `lastEpisodeBySession`:
   *      a. Classify against it as before.
   *      b. revision → reopen.
   *      c. follow_up within window (merge mode) → reopen.
   *      d. new_task / out of window → fresh episode.
   *
   *   3. Neither: bootstrap a fresh episode.
   */
  async function openEpisodeIfNeeded(
    sessionId: SessionId,
    userText: string,
    meta: Record<string, unknown>,
    agent: AgentKind,
  ): Promise<{ episode: EpisodeSnapshot; sessionId: SessionId; relation?: string }> {
    const mergeMode = algorithm.session.followUpMode === "merge_follow_ups";
    const mergeCapMs = algorithm.session.mergeMaxGapMs;
    const turnTs = timestampFromMeta(meta, "startedAtTurnTs");

    // ─── Case 1: there is a currently open episode ──────────────────
    const currentEpId = openEpisodeBySession.get(sessionId);
    if (currentEpId) {
      const open = session.sessionManager.getEpisode(currentEpId);
      if (open && open.status === "open") {
        // Build a richer context for the relation classifier, mirroring
        // the legacy `buildTopicJudgeState`: include the initial topic
        // (first user message) plus the most recent user/assistant pair
        // so the classifier sees the episode's full theme, not just the
        // tail.
        const ctx = buildClassifierContext(open.turns);
        const lastTurnTs = open.turns[open.turns.length - 1]?.ts ?? open.startedAt;
        const gapMs = Math.max(0, (turnTs ?? now()) - lastTurnTs);

        const decision = await session.relation.classify({
          prevUserText: ctx.prevUserText,
          prevAssistantText: ctx.prevAssistantText,
          newUserText: userText,
          gapMs,
        });

        log.info("relation.classified", {
          sessionId,
          prevEpisodeId: currentEpId,
          relation: decision.relation,
          confidence: decision.confidence,
          reason: decision.reason,
          gapMs,
          source: "open_episode",
        });
        buses.session.emit({
          kind: "episode.relation_classified",
          sessionId,
          episodeId: currentEpId,
          relation: decision.relation,
          confidence: decision.confidence,
          reason: decision.reason,
        });

        const withinMergeWindow = mergeCapMs === 0 || gapMs <= mergeCapMs;
        const keepAppending =
          mergeMode &&
          withinMergeWindow &&
          (decision.relation === "revision" ||
            decision.relation === "follow_up" ||
            decision.relation === "unknown");

        if (keepAppending) {
          // Same topic — just append the new user turn to the open
          // episode. No finalize, no reflect; that's deferred until
          // the user actually changes topic / closes the session.
          session.sessionManager.addTurn(currentEpId, {
            role: "user",
            content: userText,
            ts: turnTs,
            meta: {
              source: "follow_up",
              classifiedRelation: decision.relation,
              ...meta,
            },
          });
          return { episode: open, sessionId, relation: decision.relation };
        }

        // Topic changed (new_task) OR gap too large OR
        // episode_per_turn mode — finalize the open episode, which
        // fires `episode.finalized` → captureSubscriber.runReflect →
        // R_human + V backprop. Fire-and-forget; the chain runs on
        // its own clock (tests can drive it via `flush()`).
        log.info("episode.topic_boundary_close", {
          sessionId,
          episodeId: currentEpId,
          relation: decision.relation,
          gapMs,
          mergeMode,
          withinMergeWindow,
        });
        session.sessionManager.finalizeEpisode(currentEpId);
        openEpisodeBySession.delete(sessionId);

        // V7 §0.1 "new task": previous episode's arc closes, but the
        // SESSION stays the same. OpenClaw maps `(agentId, sessionKey)`
        // to exactly one `bridgeSessionId`; minting a fresh session id
        // here used to leave two orphans behind —
        // (a) the brand-new empty episode because the bridge's
        //     `openEpisodeBySession` cache (keyed on the ORIGINAL
        //     sessionId) never saw the new id and fell into its
        //     lazy-open branch on `handleAgentEnd`, creating yet
        //     another episode under the old session;
        // (b) the never-ended "新任务" placeholder that surfaced in the
        //     task list as "未命名任务" (1 turns, empty dialogue).
        // Keeping `sessionId` stable collapses all of that: one session,
        // one open episode at a time, guaranteed. The `new_task`
        // distinction is preserved via `lastEpisodeBySession.delete`
        // (so no stale prev-episode is available for relation
        // reclassification on the next turn) and the episode's meta.
        if (decision.relation === "new_task") {
          lastEpisodeBySession.delete(sessionId);
          const snap = await session.sessionManager.startEpisode({
            sessionId,
            userMessage: userText,
            ts: turnTs,
            meta: { ...meta, relation: "new_task" },
          });
          openEpisodeBySession.set(sessionId, snap.id as EpisodeId);
          return { episode: snap, sessionId, relation: decision.relation };
        }

        // Same session, new episode (gap too long or
        // episode_per_turn). Snapshot the just-closed one for
        // possible later relation classification + reopen.
        lastEpisodeBySession.set(sessionId, {
          episodeId: currentEpId,
          endedAt: now(),
          userText: ctx.prevUserText.slice(0, 1000),
          assistantText: ctx.prevAssistantText.slice(0, 2000),
        });
        const fresh = await session.sessionManager.startEpisode({
          sessionId,
          userMessage: userText,
          ts: turnTs,
          meta: { ...meta, relation: decision.relation, gapMs },
        });
        openEpisodeBySession.set(sessionId, fresh.id as EpisodeId);
        return { episode: fresh, sessionId, relation: decision.relation };
      }
      // Open episode disappeared (race). Fall through to the
      // closed-episode path below.
      openEpisodeBySession.delete(sessionId);
    }

    // ─── Case 2: there's a previously-closed episode ────────────────
    const prev = lastEpisodeBySession.get(sessionId);
    if (!prev) {
      const recoverable = findRecoverableOpenTopic(sessionId, turnTs ?? now());
      if (recoverable) {
        const snapshot = session.sessionManager.hydrateEpisode(recoverable);
        const ctx = buildClassifierContext(snapshot.turns);
        const lastTurnTs = snapshot.turns[snapshot.turns.length - 1]?.ts ?? snapshot.startedAt;
        const gapMs = Math.max(0, (turnTs ?? now()) - lastTurnTs);
        const hardWindowMs = staleTopicWindowMs();

        if (gapMs > hardWindowMs) {
          log.info("episode.recovered_topic_hard_boundary", {
            sessionId,
            episodeId: snapshot.id,
            gapMs,
            hardWindowMs,
          });
          if (snapshot.status === "open") {
            session.sessionManager.finalizeEpisode(snapshot.id as EpisodeId, {
              patchMeta: {
                topicState: "ended",
                recoveryReason: "hard_timeout_before_new_turn",
              },
            });
          }
        } else {
          const decision = await session.relation.classify({
            prevUserText: ctx.prevUserText,
            prevAssistantText: ctx.prevAssistantText,
            newUserText: userText,
            gapMs,
          });

          log.info("relation.classified", {
            sessionId,
            prevEpisodeId: snapshot.id,
            relation: decision.relation,
            confidence: decision.confidence,
            reason: decision.reason,
            gapMs,
            source: "recovered_open_topic",
          });
          buses.session.emit({
            kind: "episode.relation_classified",
            sessionId,
            episodeId: snapshot.id as EpisodeId,
            relation: decision.relation,
            confidence: decision.confidence,
            reason: decision.reason,
          });

          const withinMergeWindow = mergeCapMs === 0 || gapMs <= mergeCapMs;
          const keepAppending =
            mergeMode &&
            withinMergeWindow &&
            (decision.relation === "revision" ||
              decision.relation === "follow_up" ||
              decision.relation === "unknown");

          if (keepAppending) {
            if (snapshot.status === "closed") {
              session.sessionManager.reopenEpisode(
                snapshot.id as EpisodeId,
                decision.relation === "revision" ? "revision" : "follow_up",
              );
            }
            session.sessionManager.addTurn(snapshot.id as EpisodeId, {
              role: "user",
              content: userText,
              ts: turnTs,
              meta: {
                source: "recovered_topic",
                classifiedRelation: decision.relation,
                previousSessionId: snapshot.sessionId,
                ...meta,
              },
            });
            openEpisodeBySession.set(sessionId, snapshot.id as EpisodeId);
            lastEpisodeBySession.delete(sessionId);
            return {
              episode: session.sessionManager.getEpisode(snapshot.id as EpisodeId) ?? snapshot,
              sessionId,
              relation: decision.relation,
            };
          }

          if (snapshot.status === "open") {
            session.sessionManager.finalizeEpisode(snapshot.id as EpisodeId, {
              patchMeta: {
                topicState: "ended",
                boundaryRelation: decision.relation,
                boundaryReason: decision.reason,
              },
            });
          }
        }
      }
      // ─── Case 3: bootstrap ──────────────────────────────────────
      const snap = await session.sessionManager.startEpisode({
        sessionId,
        userMessage: userText,
        ts: turnTs,
        meta,
      });
      openEpisodeBySession.set(sessionId, snap.id as EpisodeId);
      return { episode: snap, sessionId, relation: "bootstrap" };
    }

    const gapMs = Math.max(0, (turnTs ?? now()) - prev.endedAt);
    const decision = await session.relation.classify({
      prevUserText: prev.userText,
      prevAssistantText: prev.assistantText,
      newUserText: userText,
      gapMs,
    });

    log.info("relation.classified", {
      sessionId,
      prevEpisodeId: prev.episodeId,
      relation: decision.relation,
      confidence: decision.confidence,
      reason: decision.reason,
      gapMs,
      source: "closed_episode",
    });
    buses.session.emit({
      kind: "episode.relation_classified",
      sessionId,
      episodeId: prev.episodeId,
      relation: decision.relation,
      confidence: decision.confidence,
      reason: decision.reason,
    });

    const withinMergeWindow = mergeCapMs === 0 || gapMs <= mergeCapMs;
    const shouldReopen =
      decision.relation === "revision" ||
      (mergeMode && decision.relation === "follow_up" && withinMergeWindow) ||
      (mergeMode && decision.relation === "unknown" && withinMergeWindow);

    if (shouldReopen) {
      const reopenReason =
        decision.relation === "revision" ? "revision" : "follow_up";
      const snap = session.sessionManager.reopenEpisode(prev.episodeId, reopenReason);
      session.sessionManager.addTurn(prev.episodeId, {
        role: "user",
        content: userText,
        ts: turnTs,
        meta: {
          source: reopenReason,
          classifiedRelation: decision.relation,
          ...meta,
        },
      });
      openEpisodeBySession.set(sessionId, prev.episodeId);
      lastEpisodeBySession.delete(sessionId);
      return { episode: snap, sessionId, relation: decision.relation };
    }

    if (decision.relation === "new_task") {
      // V7 §0.1 "new task": the previous episode's arc is closed, but
      // the SESSION stays the same. OpenClaw maps its (agentId,
      // sessionKey) pair to exactly one `bridgeSessionId`; minting a
      // fresh session id here used to leave two orphans behind —
      // (a) the brand-new empty episode (because the bridge's
      //     `openEpisodeBySession` cache keyed on the ORIGINAL
      //     sessionId never saw the new id and fell into its lazy-open
      //     branch on `handleAgentEnd`, creating yet another episode),
      // (b) the never-ended "新任务" placeholder that surfaced in the
      //     task list as "未命名任务".
      // Keeping sessionId stable collapses all of that: one session,
      // one open episode at a time, guaranteed.
      openEpisodeBySession.delete(sessionId);
      lastEpisodeBySession.delete(sessionId);
      const snap = await session.sessionManager.startEpisode({
        sessionId,
        userMessage: userText,
        ts: turnTs,
        meta: { ...meta, relation: "new_task" },
      });
      openEpisodeBySession.set(sessionId, snap.id as EpisodeId);
      return { episode: snap, sessionId, relation: decision.relation };
    }

    const snap = await session.sessionManager.startEpisode({
      sessionId,
      userMessage: userText,
      ts: turnTs,
      meta: { ...meta, relation: decision.relation },
    });
    openEpisodeBySession.set(sessionId, snap.id as EpisodeId);
    return { episode: snap, sessionId, relation: decision.relation };
  }

  function finalizeOpenEpisode(sessionId: SessionId, rTask?: number | null): void {
    const id = openEpisodeBySession.get(sessionId);
    if (!id) return;
    const snap = session.sessionManager.getEpisode(id);
    if (!snap || snap.status !== "open") {
      openEpisodeBySession.delete(sessionId);
      return;
    }
    session.sessionManager.finalizeEpisode(id, {
      rTask: rTask ?? null,
    });
    openEpisodeBySession.delete(sessionId);
  }

  function staleTopicWindowMs(): number {
    return Math.max(
      algorithm.session.mergeMaxGapMs * 2,
      4 * 60 * 60 * 1000,
    );
  }

  function findRecoverableOpenTopic(
    currentSessionId: SessionId,
    atTs: number,
  ): EpisodeSnapshot | null {
    const candidates = deps.repos.episodes.list({ limit: 50 });
    for (const row of candidates) {
      const meta = (row as { meta?: Record<string, unknown> }).meta ?? {};
      if (meta.boundaryRelation === "new_task") continue;
      const ageMs = Math.max(0, atTs - (row.endedAt ?? row.startedAt));
      if (ageMs > staleTopicWindowMs()) continue;
      if (row.status === "closed" && meta.closeReason !== "finalized") continue;
      if (
        row.sessionId !== currentSessionId &&
        meta.topicState !== "paused" &&
        meta.topicState !== "interrupted"
      ) {
        continue;
      }
      // Prefer the same session, but allow cross-session continuation
      // after Hermes/OpenClaw restarts. New-topic classification below
      // will close unrelated candidates before bootstrapping a fresh one.
      if (row.sessionId !== currentSessionId && candidates.length > 1) {
        const sameSession = candidates.some((c) => c.sessionId === currentSessionId);
        if (sameSession) continue;
      }
      return snapshotFromOpenEpisodeRow(row);
    }
    return null;
  }

  function snapshotFromOpenEpisodeRow(
    ep: ReturnType<typeof deps.repos.episodes.list>[number],
  ): EpisodeSnapshot {
    const traceIds = (ep.traceIds ?? []) as TraceId[];
    const traces =
      traceIds.length > 0
        ? deps.repos.traces
            .getManyByIds(traceIds)
            .sort((a, b) => a.ts - b.ts)
        : [];
    const turns: EpisodeSnapshot["turns"] = [];
    const meta = (ep as { meta?: Record<string, unknown> }).meta ?? {};
    const initialUserText =
      typeof meta.initialUserText === "string"
        ? meta.initialUserText
        : typeof meta.pendingUserText === "string"
          ? meta.pendingUserText
          : "";
    if (initialUserText && traces.length === 0) {
      turns.push({
        id: `${ep.id}:initial-user`,
        ts: ep.startedAt,
        role: "user",
        content: initialUserText,
        meta: { recovered: true },
      });
    }
    for (const tr of traces) {
      if (tr.userText) {
        turns.push({
          id: `${tr.id}:user`,
          ts: tr.ts,
          role: "user",
          content: tr.userText,
        });
      }
      if (tr.toolCalls.length > 0) {
        turns.push({
          id: `${tr.id}:tool`,
          ts: tr.ts,
          role: "tool",
          content: JSON.stringify(tr.toolCalls),
          meta: { toolCalls: tr.toolCalls },
        });
      }
      if (tr.agentText) {
        turns.push({
          id: `${tr.id}:assistant`,
          ts: tr.ts,
          role: "assistant",
          content: tr.agentText,
          meta: {
            agentThinking: tr.agentThinking ?? undefined,
            reflection: tr.reflection ?? undefined,
          },
        });
      }
    }
    const maybeIntent = (meta as { intent?: Partial<import("../session/index.js").IntentDecision> }).intent;
    return {
      id: ep.id as EpisodeId,
      sessionId: ep.sessionId as SessionId,
      startedAt: ep.startedAt,
      endedAt: ep.endedAt ?? null,
      status: ep.status,
      rTask: ep.rTask ?? null,
      turnCount: turns.length,
      turns,
      traceIds,
      meta,
      intent: {
        kind: maybeIntent?.kind ?? "unknown",
        confidence: maybeIntent?.confidence ?? 0,
        reason: maybeIntent?.reason ?? "recovered open topic",
        retrieval: maybeIntent?.retrieval ?? { tier1: true, tier2: true, tier3: true },
        signals: maybeIntent?.signals ?? ["recovered_open_topic"],
        llmModel: maybeIntent?.llmModel,
      },
    };
  }

  // ─── subscribeEvents / subscribeLogs ────────────────────────────────────

  function subscribeEvents(handler: (e: CoreEvent) => void): () => void {
    eventListeners.add(handler);
    return () => eventListeners.delete(handler);
  }

  const logSubscription = onBroadcastLog((record) => {
    for (const listener of logListeners) {
      try {
        listener(record);
      } catch (err) {
        log.warn("log.listener_threw", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  function subscribeLogs(handler: (r: LogRecord) => void): () => void {
    // Replay the last window so adapters that subscribe late still
    // capture recent context.
    for (const rec of memoryBuffer().tail({ limit: 64 }).reverse()) {
      try {
        handler(rec);
      } catch {
        /* adapter is responsible */
      }
    }
    logListeners.add(handler);
    return () => logListeners.delete(handler);
  }

  // ─── Retrieval entry points ─────────────────────────────────────────────

  const retrievalDeps = buildRetrievalDeps(deps, algorithm);
  const turnStartRetrievalStats = new Map<string, RetrievalResult["stats"]>();

  async function retrieveTurnStart(input: TurnInputDTO): Promise<InjectionPacket> {
    const ctx = {
      reason: "turn_start" as const,
      agent: input.agent,
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      userText: input.userText,
      contextHints: input.contextHints,
      ts: input.ts,
    };
    const result: RetrievalResult = await turnStartRetrieve(
      retrievalDeps,
      ctx,
      { events: buses.retrieval },
    );
    turnStartRetrievalStats.set(result.packet.packetId, result.stats);
    return result.packet;
  }

  function consumeRetrievalStats(packetId: string): RetrievalResult["stats"] | null {
    const stats = turnStartRetrievalStats.get(packetId) ?? null;
    turnStartRetrievalStats.delete(packetId);
    return stats;
  }

  async function retrieveToolDriven(ctx: ToolDrivenCtx): Promise<InjectionPacket> {
    const result = await toolDrivenRetrieve(
      retrievalDeps,
      { reason: "tool_driven", ...ctx },
      { events: buses.retrieval },
    );
    return result.packet;
  }

  async function retrieveSkillInvoke(ctx: SkillInvokeCtx): Promise<InjectionPacket> {
    const result = await skillInvokeRetrieve(
      retrievalDeps,
      { reason: "skill_invoke", ...ctx },
      { events: buses.retrieval },
    );
    return result.packet;
  }

  async function retrieveSubAgent(ctx: SubAgentCtx): Promise<InjectionPacket> {
    const result = await subAgentRetrieve(
      retrievalDeps,
      { reason: "sub_agent", ...ctx },
      { events: buses.retrieval },
    );
    return result.packet;
  }

  async function retrieveRepair(ctx: RepairCtx): Promise<InjectionPacket | null> {
    const result = await repairRetrieve(
      retrievalDeps,
      { reason: "decision_repair", ...ctx },
      { events: buses.retrieval },
    );
    return result ? result.packet : null;
  }

  // ─── Turn lifecycle ─────────────────────────────────────────────────────

  async function onTurnStart(input: TurnInputDTO): Promise<InjectionPacket> {
    const t0 = now();
    const initialSessionId = await ensureSession(
      input.agent,
      input.sessionId,
      input.contextHints,
    );

    const routing = await openEpisodeIfNeeded(
      initialSessionId,
      input.userText,
      {
        contextHints: input.contextHints ?? {},
        agent: input.agent,
        startedAtTurnTs: input.ts,
      },
      input.agent,
    );

    const sessionId = routing.sessionId;
    const episode = routing.episode;
    lastUserTextBySession.set(sessionId, input.userText);

    const normalized: TurnInputDTO = {
      ...input,
      sessionId,
      episodeId: episode.id as EpisodeId,
    };

    try {
      const packet = await retrieveTurnStart(normalized);
      // Always stamp the routed sessionId + episodeId on the packet so
      // adapters can correlate the subsequent `agent_end` / `turn.end`
      // call without needing a separate round-trip to the session
      // manager. Without this, the adapter-side `openEpisodeBySession`
      // cache stays empty and `onTurnEnd` falls back to a synthetic
      // episode id that fails DB lookup.
      const stamped: InjectionPacket = {
        ...packet,
        sessionId,
        episodeId: episode.id as EpisodeId,
      };
      log.info("turn.started", {
        agent: input.agent,
        sessionId,
        episodeId: episode.id,
        userChars: input.userText.length,
        retrievalTotalMs: packet.tierLatencyMs.tier1 +
          packet.tierLatencyMs.tier2 +
          packet.tierLatencyMs.tier3,
        elapsedMs: now() - t0,
      });
      return stamped;
    } catch (err) {
      log.error("turn.retrieval_failed", {
        agent: input.agent,
        sessionId,
        episodeId: episode.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return emptyInjectionPacket(input.agent, sessionId, episode.id as EpisodeId, input.ts);
    }
  }

  async function onTurnEnd(result: TurnResultDTO): Promise<TurnEndResult> {
    const sessionId = await ensureSession(
      result.agent,
      result.sessionId,
      result.contextHints,
    );
    const episodeId = openEpisodeBySession.get(sessionId) ?? result.episodeId;
    if (!episodeId) {
      throw new Error(
        "pipeline.onTurnEnd: no open episode for session " + sessionId,
      );
    }
    const episode = session.sessionManager.getEpisode(episodeId);
    if (!episode || episode.status !== "open") {
      throw new Error(
        "pipeline.onTurnEnd: episode " + episodeId + " is not open",
      );
    }
    if (result.contextHints && Object.keys(result.contextHints).length > 0) {
      session.sessionManager.patchEpisodeMeta(episodeId, {
        contextHints: {
          ...((episode.meta.contextHints as Record<string, unknown> | undefined) ?? {}),
          ...result.contextHints,
        },
      });
    }

    // V7 §0.1: record tool-call turns BEFORE the assistant turn so the
    // episode snapshot contains the full execution trace in chronological
    // order. This mirrors the legacy `memos-local-openclaw` adapter which
    // stored tool messages as separate chunks with `role: "tool"`.
    // Without these turns the capture step-extractor still picks up
    // `meta.toolCalls`, but the viewer's timeline and the reward scorer
    // need the turns to count exchanges correctly and display the chat log.
    for (const tc of result.toolCalls) {
      session.sessionManager.addTurn(episodeId, {
        role: "tool",
        content: typeof tc.output === "string"
          ? tc.output
          : tc.output != null
            ? JSON.stringify(tc.output).slice(0, 2000)
            : "",
        ts: Number.isFinite(tc.endedAt) ? tc.endedAt : result.ts,
        meta: {
          tool: tc.name,
          name: tc.name,
          input: tc.input,
          errorCode: tc.errorCode,
          toolCallId: tc.toolCallId,
          startedAt: tc.startedAt,
          endedAt: tc.endedAt,
          // V7 §0.1: preserve the model's "Thought for X" narration that
          // precedes this call so `step-extractor` can re-attach it to
          // the captured ToolCallDTO. Without this, chained tool calls
          // lose the natural-language bridge between steps.
          thinkingBefore: tc.thinkingBefore,
          assistantTextBefore: tc.assistantTextBefore,
        },
      });
    }

    session.sessionManager.addTurn(episodeId, {
      role: "assistant",
      content: result.agentText,
      ts: result.ts,
      meta: {
        toolCalls: result.toolCalls,
        // V7 §0.1 split:
        //   - `agentThinking` = LLM-native thinking (Claude extended,
        //     pi-ai ThinkingContent). Belongs to the conversation log.
        //   - `reflection` = adapter-supplied (rare). NEVER shown in
        //     chat — the topic-end reflect pass writes the canonical
        //     reflection field on the trace row.
        agentThinking: result.agentThinking ?? null,
        reflection: result.reflection ?? null,
        contextHints: result.contextHints ?? {},
        ts: result.ts,
      },
    });

    // Snapshot the now-augmented episode and run the lite capture
    // pass. This writes a trace row for the new step with
    // `reflection=null` + `alpha=0` so the viewer can show the
    // memory immediately — but no scoring happens yet. The full
    // reflect + reward chain only fires when the topic actually ends
    // (next turn classified as `new_task`, idle timeout, session_end,
    // or shutdown).
    const liveEpisode = session.sessionManager.getEpisode(episodeId);
    let liteTraceIds: string[] = [];
    if (liveEpisode) {
      try {
        const captureResult = await subs.captureRunner.runLite({ episode: liveEpisode });
        liteTraceIds = captureResult.traceIds;
        if (captureResult.traceIds.length > 0) {
          session.sessionManager.attachTraceIds(episodeId, captureResult.traceIds as string[]);
        }
      } catch (err) {
        log.warn("turn.lite_capture.failed", {
          episodeId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Update the "current open episode" snapshot so the relation
    // classifier on the NEXT onTurnStart can decide whether the user
    // changed topic. We mirror the data shape of `lastEpisodeBySession`
    // even though the episode isn't closed yet — the classifier doesn't
    // care about `endedAt`, only about prev-user / prev-assistant text.
    const initialUserTurn = liveEpisode?.turns.find((t) => t.role === "user");
    lastEpisodeBySession.set(sessionId, {
      episodeId,
      endedAt: now(),
      userText: (initialUserTurn?.content ?? "").slice(0, 1000),
      assistantText: (result.agentText ?? "").slice(0, 2000),
    });

    log.info("turn.ended", {
      agent: result.agent,
      sessionId,
      episodeId,
      toolCalls: result.toolCalls.length,
      agentChars: result.agentText.length,
    });

    // The episode stays OPEN — finalize is deferred to topic end.
    return {
      traceCount: liteTraceIds.length,
      traceIds: liteTraceIds,
      episodeId: episodeId as EpisodeId,
      episode: liveEpisode ?? null,
      episodeFinalized: false,
      asyncWorkScheduled: true,
    };
  }

  // ─── Tool outcomes (decision repair) ────────────────────────────────────

  function recordToolOutcome(outcome: RecordToolOutcomeInput): void {
    const sessionId = outcome.sessionId;
    const context =
      outcome.context ??
      lastUserTextBySession.get(sessionId) ??
      sessionId;
    if (outcome.success) {
      subs.feedback.recordToolSuccess({
        toolId: outcome.tool,
        context,
        step: outcome.step,
        sessionId,
        episodeId: outcome.episodeId,
      });
      return;
    }
    subs.feedback.recordToolFailure({
      toolId: outcome.tool,
      context,
      step: outcome.step,
      reason: outcome.errorCode ?? "unknown",
      sessionId,
      episodeId: outcome.episodeId,
    });
  }

  // ─── flush / shutdown ───────────────────────────────────────────────────

  async function flush(): Promise<void> {
    // Order matters: capture writes traces, reward reads them and
    // emits `reward.updated` → L2 induces policies & emits
    // `l2.policy.induced` → L3 abstracts world models → skills
    // crystallize. Each layer is its own subscriber, so we walk the
    // chain explicitly. A few ticks between waits let scheduled
    // `void run(...)` promises register in their owners' inflight
    // sets before we ask each one to drain.
    const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

    await subs.subscriptions.capture.drain();
    await nextTick();
    await subs.subscriptions.reward.drain();
    await nextTick();
    // L2 receives `reward.updated` and runs the induce/associate
    // pipeline (LLM call, ~5s). Without draining it here, single-
    // shot adapters (Hermes' `chat -q`) reap the bridge before L2
    // finishes — the candidate pool fills up but no policy is ever
    // induced.
    await subs.l2.drain();
    await nextTick();
    // L3 reacts to `l2.policy.induced`. Same problem, same fix.
    await subs.l3.drain();
    await nextTick();
    await subs.skills.flush();
    await subs.feedback.flush();
    await embeddingRetryWorker.flush();
  }

  async function shutdown(reason: string = "shutdown"): Promise<void> {
    log.info("pipeline.shutdown.begin", { reason });
    try {
      await flush();
    } catch (err) {
      log.warn("pipeline.flush_failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // Detach subscribers — prevents late events from re-queuing work.
    subs.subscriptions.capture.stop();
    subs.subscriptions.reward.stop();
    subs.l2.detach();
    subs.l3.detach();
    subs.skills.dispose();
    subs.feedback.dispose();
    embeddingRetryWorker.stop();
    bridge.dispose();
    logSubscription();
    session.sessionManager.shutdown(reason);
    log.info("pipeline.shutdown.done", { reason });
  }

  function now(): number {
    return (deps.now ?? Date.now)();
  }

  function timestampFromMeta(meta: Record<string, unknown>, key: string): number | undefined {
    const ts = meta[key];
    return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
  }

  /**
   * Build richer context for the relation classifier from episode turns.
   *
   * Mirrors legacy `buildTopicJudgeState`: includes the first user message
   * (topic anchor) plus the most recent user/assistant pair, so the
   * classifier sees the episode's overall theme — not just the tail.
   * This prevents false `new_task` splits when a later turn circles back
   * to the original topic after a tangent.
   */
  function buildClassifierContext(
    turns: ReadonlyArray<{ role: string; content: string }>,
  ): { prevUserText: string; prevAssistantText: string } {
    const userTurns = turns.filter((t) => t.role === "user");
    const assistantTurns = turns.filter((t) => t.role === "assistant");

    const firstUser = userTurns[0]?.content ?? "";
    const lastUser = userTurns[userTurns.length - 1]?.content ?? "";
    const lastAssistant = assistantTurns[assistantTurns.length - 1]?.content ?? "";

    // For single-turn episodes the first and last are the same.
    let prevUserText: string;
    if (userTurns.length <= 1 || firstUser === lastUser) {
      prevUserText = lastUser.slice(0, 1000);
    } else {
      // Multi-turn: pack the initial topic + the most recent user query.
      prevUserText = [
        `[Task topic]: ${firstUser.slice(0, 300)}`,
        `[Latest user message]: ${lastUser.slice(0, 700)}`,
      ].join("\n\n");
    }

    return {
      prevUserText,
      prevAssistantText: lastAssistant.slice(0, 2000),
    };
  }

  // ─── Handle object ──────────────────────────────────────────────────────

  const handle: PipelineHandle = {
    agent: deps.agent,
    home: deps.home,
    config: deps.config,
    algorithm,
    db: deps.db,
    repos: deps.repos,
    llm: deps.llm,
    reflectLlm: deps.reflectLlm,
    embedder: deps.embedder,
    sessionManager: session.sessionManager,
    episodeManager: session.episodeManager,
    intent: session.intent,
    relation: session.relation,
    captureRunner: subs.captureRunner,
    rewardRunner: subs.rewardRunner,
    l2: subs.l2,
    l3: subs.l3,
    skills: subs.skills,
    feedback: subs.feedback,
    buses,
    subscribeEvents,
    getRecentEvents,
    subscribeLogs,
    onTurnStart,
    consumeRetrievalStats,
    onTurnEnd,
    recordToolOutcome,
    retrieveToolDriven,
    retrieveSkillInvoke,
    retrieveSubAgent,
    retrieveRepair,
    flush,
    shutdown,
    retrievalDeps: () => retrievalDeps,
  };

  log.info("pipeline.ready", {
    agent: deps.agent,
    home: deps.home.root,
    algorithm: {
      captureEmbed: algorithm.capture.embedTraces,
      rewardDecayDays: algorithm.reward.decayHalfLifeDays,
      l2MinSim: algorithm.l2Induction.minSimilarity,
      skillMinSupport: algorithm.skill.minSupport,
      feedbackThreshold: algorithm.feedback.failureThreshold,
    },
  });

  // We expose the contextHashOf helper indirectly for tests that want to
  // assert the subscriber is seeing the right context bucket.
  void contextHashOf; // reference to make bundlers keep the symbol
  void _assertConfigShape(algorithm, deps.config.algorithm.feedback);

  return handle;
}

function emptyInjectionPacket(
  _agent: AgentKind,
  sessionId: SessionId,
  episodeId: EpisodeId,
  ts: number,
): InjectionPacket {
  return {
    reason: "turn_start",
    snippets: [],
    rendered: "",
    tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    packetId: `empty:${sessionId}:${episodeId}:${ts}`,
    ts,
    sessionId,
    episodeId,
  };
}

function _assertConfigShape(
  algorithm: PipelineAlgorithmConfig,
  feedback: FeedbackConfig,
): void {
  // Pure-TypeScript assertion: would fail type-check if shape drifted.
  // Kept live at runtime to make the call path visible in stack traces.
  if (!algorithm.feedback) throw new Error("feedback config missing");
  if (!feedback.failureThreshold) throw new Error("failureThreshold missing");
}
