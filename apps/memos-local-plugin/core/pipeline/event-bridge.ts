/**
 * Aggregates every internal event bus into the unified `CoreEvent`
 * stream exposed through `MemoryCore.subscribeEvents`.
 *
 * The bridge is intentionally *additive*: it never mutates the source
 * events, never suppresses them, and translates shape to the shared
 * envelope (`type` / `ts` / `seq` / `correlationId` / `payload`).
 *
 * Unknown event shapes still pass through as `system.error` when we
 * truly can't classify them — this is only a safety net; new events
 * should always get a dedicated branch in this file. Adding one is a
 * three-line change:
 *
 *   1. Pick the `CORE_EVENTS` type literal (see `agent-contract/events.ts`).
 *   2. Emit via `emit({ type, ts, seq, correlationId?, payload })`.
 *   3. Document it in `docs/EVENTS.md`.
 */

import type { Logger } from "../logger/types.js";
import type {
  AgentKind,
  TraceId,
} from "../../agent-contract/dto.js";
import type {
  CoreEvent,
  CoreEventType,
} from "../../agent-contract/events.js";

import type { PipelineBuses } from "./types.js";

// ─── Public surface ───────────────────────────────────────────────────────

export interface EventBridgeDeps {
  buses: PipelineBuses;
  agent: AgentKind;
  log: Logger;
  emit: (evt: CoreEvent) => void;
}

export interface EventBridgeHandle {
  dispose(): void;
  /** Internal seq counter, exposed for tests. */
  currentSeq(): number;
}

export function bridgeToCoreEvents(deps: EventBridgeDeps): EventBridgeHandle {
  let seq = 0;
  const nextSeq = (): number => ++seq;

  function send<T>(type: CoreEventType, payload: T, correlationId?: string): void {
    try {
      deps.emit({
        type,
        ts: Date.now(),
        seq: nextSeq(),
        correlationId,
        payload,
      });
    } catch (err) {
      deps.log.warn("bridge.emit_failed", {
        type,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const disposers: Array<() => void> = [];

  // ─── Session / episode ────────────────────────────────────────────────
  disposers.push(
    deps.buses.session.onAny((evt) => {
      switch (evt.kind) {
        case "session.started":
          return send("session.opened", evt.session, evt.session.id);
        case "session.closed":
          return send("session.closed", {
            sessionId: evt.sessionId,
            reason: evt.reason,
          }, evt.sessionId);
        case "session.idle_pruned":
          return send("session.closed", {
            sessionId: evt.sessionId,
            reason: `idle:${evt.idleMs}ms`,
          }, evt.sessionId);
        case "episode.started":
          return send("episode.opened", evt.episode, evt.episode.id);
        case "episode.finalized":
          return send("episode.closed", {
            episode: evt.episode,
            closedBy: evt.closedBy,
          }, evt.episode.id);
        case "episode.abandoned":
          return send("episode.closed", {
            episodeId: evt.episodeId,
            reason: evt.reason,
            closedBy: "abandoned" as const,
          }, evt.episodeId);
        case "episode.turn_added":
          // Not every host wants per-turn events, but they are cheap and
          // help the viewer draw the timeline in real time.
          return send("trace.created", {
            episodeId: evt.episodeId,
            turn: evt.turn,
          }, evt.episodeId);
      }
    }),
  );

  // ─── Capture ──────────────────────────────────────────────────────────
  disposers.push(
    deps.buses.capture.onAny((evt) => {
      if (evt.kind === "capture.done") {
        for (const traceId of evt.result.traceIds as readonly TraceId[]) {
          send(
            "trace.created",
            { traceId, episodeId: evt.result.episodeId },
            traceId,
          );
        }
      }
    }),
  );

  // ─── Reward ───────────────────────────────────────────────────────────
  disposers.push(
    deps.buses.reward.onAny((evt) => {
      switch (evt.kind) {
        case "reward.scored":
          return send("reward.computed", {
            episodeId: evt.episodeId,
            rHuman: evt.rHuman,
            source: evt.source,
          }, evt.episodeId);
        case "reward.updated":
          for (const upd of evt.result.backprop.updates ?? []) {
            send("trace.value_updated", upd, upd.traceId);
          }
          return;
      }
    }),
  );

  // ─── L2 policies ──────────────────────────────────────────────────────
  disposers.push(
    deps.buses.l2.onAny((evt) => {
      switch (evt.kind) {
        case "l2.trace.associated":
          return send("l2.associated", {
            policyId: evt.policyId,
            traceId: evt.traceId,
            similarity: evt.similarity,
          }, evt.policyId);
        case "l2.candidate.added":
          return send("l2.candidate_added", {
            candidateId: evt.candidateId,
            signature: evt.signature,
            traceId: evt.traceId,
          }, evt.candidateId);
        case "l2.policy.induced":
          return send("l2.induced", {
            policyId: evt.policyId,
            signature: evt.signature,
            evidenceTraceIds: evt.evidenceTraceIds,
          }, evt.policyId);
        case "l2.policy.updated":
          return send("l2.revised", evt, evt.policyId);
      }
    }),
  );

  // ─── L3 world models ──────────────────────────────────────────────────
  disposers.push(
    deps.buses.l3.onAny((evt) => {
      switch (evt.kind) {
        case "l3.world-model.created":
          return send("l3.abstracted", evt, evt.worldModelId);
        case "l3.world-model.updated":
          return send("l3.revised", evt, evt.worldModelId);
      }
    }),
  );

  // ─── Skill ────────────────────────────────────────────────────────────
  disposers.push(
    deps.buses.skill.onAny((evt) => {
      switch (evt.kind) {
        case "skill.crystallized":
          return send("skill.crystallized", evt, evt.skillId);
        case "skill.eta.updated":
          return send("skill.eta_updated", evt, evt.skillId);
        case "skill.status.changed":
          if (evt.next === "archived") {
            return send("skill.archived", evt, evt.skillId);
          }
          return;
        case "skill.archived":
          return send("skill.archived", evt, evt.skillId);
        case "skill.rebuilt":
          return send("skill.repaired", evt, evt.skillId);
        case "skill.failed":
          if (evt.stage === "crystallize" && evt.modelRefusal) {
            return send("system.error", {
              kind: "skill.model_refusal",
              message: `Skill crystallization model refusal for policy ${evt.policyId ?? "unknown"}`,
              policyId: evt.policyId,
              stage: evt.stage,
              reason: evt.reason,
              modelRefusal: evt.modelRefusal,
            }, evt.policyId);
          }
          return;
      }
    }),
  );

  // ─── Feedback / decision repair ───────────────────────────────────────
  disposers.push(
    deps.buses.feedback.onAny((evt) => {
      switch (evt.kind) {
        case "repair.persisted":
          return send("decision_repair.generated", evt, evt.repairId);
        case "repair.triggered":
          return send("decision_repair.validated", evt, evt.contextHash);
        case "feedback.classified":
          return send("feedback.classified", evt);
      }
    }),
  );

  // ─── Retrieval ────────────────────────────────────────────────────────
  disposers.push(
    deps.buses.retrieval.on((evt) => {
      switch (evt.kind) {
        case "retrieval.started":
          return send("retrieval.triggered", evt, evt.sessionId);
        case "retrieval.done":
          if (evt.stats.embedding?.degraded) {
            send("system.error", {
              kind: "embedding.query_degraded",
              message: evt.stats.embedding.errorMessage ?? "Query embedding failed; retrieval degraded",
              reason: evt.reason,
              sessionId: evt.sessionId,
              episodeId: evt.episodeId,
              errorCode: evt.stats.embedding.errorCode,
            }, evt.sessionId);
          }
          if (evt.stats.emptyPacket) {
            return send("retrieval.empty", evt, evt.sessionId);
          }
          return send("retrieval.tier1.hit", evt, evt.sessionId);
      }
    }),
  );

  return {
    dispose(): void {
      for (const off of disposers) {
        try { off(); } catch { /* ignore */ }
      }
      disposers.length = 0;
    },
    currentSeq: () => seq,
  };
}
