/**
 * Retrieval-scoped event bus.
 *
 * Mirrors `createCaptureEventBus` / `createRewardEventBus`. We keep the
 * three pipelines on their own buses so that public adapters can subscribe
 * to "only retrieval" without type-unioning every kind in `core/`.
 *
 * The Phase 15 orchestrator is responsible for forwarding these to the
 * unified pipeline bus if/when the host wants one firehose.
 */

import type {
  AgentKind,
  EpochMs,
  InjectionPacket,
  RetrievalReason,
  SessionId,
  EpisodeId,
} from "../../agent-contract/dto.js";
import { rootLogger } from "../logger/index.js";
import type { RetrievalStats } from "./types.js";

const log = rootLogger.child({ channel: "core.retrieval.events" });

// ─── Event shapes ───────────────────────────────────────────────────────────

export type RetrievalEvent =
  | {
      kind: "retrieval.started";
      reason: RetrievalReason;
      agent: AgentKind;
      sessionId: SessionId;
      episodeId?: EpisodeId;
      queryTags: string[];
      ts: EpochMs;
    }
  | {
      kind: "retrieval.done";
      reason: RetrievalReason;
      agent: AgentKind;
      sessionId: SessionId;
      episodeId?: EpisodeId;
      packet: InjectionPacket;
      stats: RetrievalStats;
      ts: EpochMs;
    }
  | {
      kind: "retrieval.failed";
      reason: RetrievalReason;
      agent: AgentKind;
      sessionId: SessionId;
      episodeId?: EpisodeId;
      error: { code: string; message: string };
      ts: EpochMs;
    };

export type RetrievalEventKind = RetrievalEvent["kind"];

export type RetrievalEventListener = (evt: RetrievalEvent) => void;

export interface RetrievalEventBus {
  emit(evt: RetrievalEvent): void;
  on(listener: RetrievalEventListener): () => void;
  onKind<K extends RetrievalEventKind>(
    kind: K,
    listener: (evt: Extract<RetrievalEvent, { kind: K }>) => void,
  ): () => void;
}

export function createRetrievalEventBus(): RetrievalEventBus {
  const all = new Set<RetrievalEventListener>();
  const byKind = new Map<RetrievalEventKind, Set<RetrievalEventListener>>();

  return {
    emit(evt) {
      const targets: RetrievalEventListener[] = [];
      for (const l of all) targets.push(l);
      const kl = byKind.get(evt.kind);
      if (kl) for (const l of kl) targets.push(l);

      for (const l of targets) {
        try {
          l(evt);
        } catch (err) {
          log.warn("listener_threw", {
            kind: evt.kind,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    on(listener) {
      all.add(listener);
      return () => all.delete(listener);
    },
    onKind(kind, listener) {
      let set = byKind.get(kind);
      if (!set) {
        set = new Set();
        byKind.set(kind, set);
      }
      set.add(listener as RetrievalEventListener);
      return () => {
        set!.delete(listener as RetrievalEventListener);
      };
    },
  };
}
