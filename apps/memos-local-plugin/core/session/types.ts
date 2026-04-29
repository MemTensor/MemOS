/**
 * Session & Episode contracts.
 *
 * Vocabulary (matches V7 §3.1):
 *
 *   - **Session** — a long-lived logical connection to an agent. Usually
 *     opened when the adapter starts and closed on process shutdown. All
 *     episodes that belong to the same "running agent" share one session.
 *
 *   - **Episode** — one user query (plus the agent's full response arc,
 *     including tool calls and nested sub-agents). ONE episode per turn.
 *     The episode transitions through: open → turns-added → finalized
 *     (or abandoned).
 *
 *   - **Turn** — an individual message inside the episode. The first turn
 *     is always the user's query; later turns can be assistant text,
 *     tool-call observations, or sub-agent hops.
 *
 * Intent classification runs AS THE EPISODE OPENS and governs which
 * retrieval tiers (Tier 1/2/3) the orchestrator will fire.
 */

import type { AgentKind, EpisodeId, SessionId } from "../../agent-contract/dto.js";
import type { EpochMs } from "../types.js";

// ─── Session lifecycle ──────────────────────────────────────────────────────

export interface SessionOpenInput {
  /** Optional — if absent we mint a new id. */
  id?: SessionId;
  agent: AgentKind;
  /** Free-form adapter metadata (hostPid, OS, version, etc.). */
  meta?: Record<string, unknown>;
}

export interface SessionSnapshot {
  id: SessionId;
  agent: AgentKind;
  startedAt: EpochMs;
  lastSeenAt: EpochMs;
  meta: Record<string, unknown>;
  /** Open episodes currently live inside this session. */
  openEpisodeCount: number;
}

// ─── Turn / Episode ─────────────────────────────────────────────────────────

export type TurnRole = "user" | "assistant" | "tool" | "system";

export interface EpisodeTurn {
  /** Short id for in-memory reference. Persisted as part of trace rows. */
  id: string;
  ts: EpochMs;
  role: TurnRole;
  content: string;
  /** Optional rich metadata — tool name, arguments, outcome, sub-agent id. */
  meta?: Record<string, unknown>;
}

export type EpisodeTurnInput = Omit<EpisodeTurn, "id" | "ts"> & {
  /** Adapter-provided event time. Defaults to the server receive time. */
  ts?: EpochMs;
};

export interface EpisodeStartInput {
  sessionId: SessionId;
  /** Pre-minted id (adapters sometimes pre-allocate). */
  id?: EpisodeId;
  /** The initial user query. Required — empty episodes are a programming error. */
  initialTurn: EpisodeTurnInput;
  /** Optional adapter-provided hints (e.g. sub-agent depth, tool allowlist). */
  meta?: Record<string, unknown>;
}

export interface EpisodeFinalizeInput {
  /**
   * Signed reward from the human (post-feedback). When omitted we leave
   * `r_task` null — reward scoring runs asynchronously in Phase 7.
   */
  rTask?: number | null;
  /** Optional adapter metadata (final reply id, cost estimate, etc.). */
  patchMeta?: Record<string, unknown>;
}

/**
 * Why an episode ended. "finalized" is the normal path; "abandoned" means
 * the adapter crashed mid-turn or the user disconnected. Both paths still
 * close the row in SQLite so open-episode pruning works.
 */
export type EpisodeCloseReason = "finalized" | "abandoned";

export interface EpisodeSnapshot {
  id: EpisodeId;
  sessionId: SessionId;
  startedAt: EpochMs;
  endedAt: EpochMs | null;
  status: "open" | "closed";
  rTask: number | null;
  turnCount: number;
  turns: EpisodeTurn[];
  traceIds: string[];
  meta: Record<string, unknown>;
  intent: IntentDecision;
}

// ─── Intent classification ──────────────────────────────────────────────────

/**
 * What the user's first message looks like, coarse-grained.
 *
 *   - `task`         — wants the agent to DO something. Full retrieval.
 *   - `memory_probe` — asks about past context ("what did we discuss…").
 *                      Tier 1 skills + Tier 2 trace recall only.
 *   - `chitchat`     — conversational filler. Skip retrieval entirely.
 *   - `meta`         — plugin command (e.g. `/memos status`). Adapter
 *                      handles it; orchestrator does not retrieve.
 *   - `unknown`      — classifier couldn't decide; caller should treat
 *                      like `task` as the safe default (retrieval runs).
 */
export type IntentKind = "task" | "memory_probe" | "chitchat" | "meta" | "unknown";

export interface IntentDecision {
  kind: IntentKind;
  /** 0..1. Lower means the caller should prefer broader retrieval. */
  confidence: number;
  /** Human-readable "why", ≤ 120 chars. Surfaced in frontend / audit. */
  reason: string;
  /**
   * Which retrieval tiers the orchestrator should fire for this episode.
   * Derived from `kind` but exposed explicitly so higher layers can
   * override on a whim.
   */
  retrieval: {
    tier1: boolean;
    tier2: boolean;
    tier3: boolean;
  };
  /** When an LLM classifier ran; undefined for pure-heuristic decisions. */
  llmModel?: string;
  /** Populated by `IntentClassifier` — the matching heuristic rule ids. */
  signals: string[];
}

// ─── Turn-relation classification (V7 §0.1) ────────────────────────────────

/**
 * Relationship of the **new** user turn `q_{k+1}` to the **previous**
 * episode's `q_k` + `y_hat_k`. Governs episode/session lifecycle:
 *
 *   - `revision`  — user is correcting / refining the previous answer
 *                   (same task). Same session, **same episode**. `R_human`
 *                   back-propagates to the existing L1 traces.
 *   - `follow_up` — same domain, but the previous task is done; this is a
 *                   new sub-task. Same session, **new episode**.
 *   - `new_task`  — unrelated task. **New session**, new episode.
 *   - `unknown`   — classifier couldn't decide; caller treats as
 *                   `follow_up` (safe default).
 *
 * The classifier runs at `onTurnStart` once we have both the new user
 * text and the tail of the previous episode in memory. See
 * `core/session/relation-classifier.ts` for the heuristic + LLM path.
 */
export type TurnRelation = "revision" | "follow_up" | "new_task" | "unknown";

export interface RelationDecision {
  relation: TurnRelation;
  /** 0..1. Below ~0.5 the classifier is genuinely uncertain. */
  confidence: number;
  /** Human-readable "why", ≤ 120 chars. */
  reason: string;
  /** Which heuristic rules (+ `llm`) contributed to the decision. */
  signals: string[];
  /** When an LLM classifier ran; undefined for pure-heuristic decisions. */
  llmModel?: string;
}

export interface RelationInput {
  /** Previous episode's initial user text `q_k`, if any. */
  prevUserText?: string;
  /** Previous episode's final assistant text `y_hat_k`, if any. */
  prevAssistantText?: string;
  /** The new user text `q_{k+1}`. */
  newUserText: string;
  /** Ms since the previous episode ended. Large values nudge toward new_task. */
  gapMs?: number;
  /** Domain/tag signals from the previous episode (capture.tagger output). */
  prevTags?: readonly string[];
}

// ─── Event bus ──────────────────────────────────────────────────────────────

export type SessionEvent =
  | { kind: "session.started"; session: SessionSnapshot }
  | { kind: "session.closed"; sessionId: SessionId; reason: string }
  | { kind: "session.idle_pruned"; sessionId: SessionId; idleMs: number }
  | { kind: "episode.started"; episode: EpisodeSnapshot }
  | { kind: "episode.reopened"; episode: EpisodeSnapshot; reason: TurnRelation }
  | { kind: "episode.turn_added"; episodeId: EpisodeId; turn: EpisodeTurn }
  | {
      kind: "episode.finalized";
      episode: EpisodeSnapshot;
      closedBy: EpisodeCloseReason;
    }
  | { kind: "episode.abandoned"; episodeId: EpisodeId; reason: string }
  | {
      kind: "episode.relation_classified";
      sessionId: SessionId;
      episodeId: EpisodeId;
      relation: TurnRelation;
      confidence: number;
      reason: string;
    };

export type SessionEventKind = SessionEvent["kind"];

export type SessionEventListener = (evt: SessionEvent) => void;

export interface SessionEventBus {
  on(kind: SessionEventKind, fn: SessionEventListener): () => void;
  onAny(fn: SessionEventListener): () => void;
  emit(evt: SessionEvent): void;
  listenerCount(kind?: SessionEventKind): number;
}
