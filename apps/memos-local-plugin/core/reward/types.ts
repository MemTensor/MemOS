/**
 * Internal DTOs for `core/reward`.
 *
 * The reward pipeline maps one episode → one R_human scalar →
 * reflection-weighted backprop → per-trace V_t → priority update.
 *
 * We keep things internal to the module; public exports are chosen
 * deliberately in `index.ts`.
 */

import type {
  EpisodeId,
  EpochMs,
  FeedbackId,
  FeedbackRow,
  SessionId,
  TraceId,
  TraceRow,
} from "../types.js";

// ─── Reward configuration (mirror of config.algorithm.reward) ──────────────

export interface RewardConfig {
  /** V7 §0.6 eq. 4/5: discount factor γ. */
  gamma: number;
  /** V7 §2.4.5 eq. 3: softmax τ (used downstream by L2 induction; we just expose it here). */
  tauSoftmax: number;
  /** V7 §3.3: priority decay half-life in days. */
  decayHalfLifeDays: number;
  /** When true, call the LLM to score feedback → R_human. */
  llmScoring: boolean;
  /** Magnitude threshold (|R_human|) that triggers backprop on implicit signals. */
  implicitThreshold: number;
  /** Seconds to wait for explicit feedback. 0 disables the timer. */
  feedbackWindowSec: number;
  /** Max chars in the task summary handed to the LLM. */
  summaryMaxChars: number;
  /** Concurrency for R_human LLM calls. */
  llmConcurrency: number;
  /**
   * Minimum number of user↔assistant *exchanges* (rounds) before an
   * episode is eligible for scoring. Episodes shorter than this are
   * closed as abandoned with reason "too few conversation turns" —
   * mirroring the legacy `memos-local-openclaw` shouldSkipSummary rule
   * (chunks < 4 OR min(user, assistant) < N). Default 1
   * (relaxed in 2026Q2 to admit CLI single-shot patterns; was 2).
   */
  minExchangesForCompletion: number;
  /**
   * Minimum combined characters across all user+assistant turns before
   * scoring. Trivial banter ("hi", "ok") skips summarization even if
   * the exchange count is sufficient. Default 80 — enough for a short
   * CJK or English prompt + reply, cheap enough to run offline.
   */
  minContentCharsForCompletion: number;
  /**
   * Fraction of turns that are tool calls above which an episode is
   * flagged as "tool-heavy" (combined with low assistant text → skip).
   * Default 0.7.
   */
  toolHeavyRatio: number;
  /**
   * Minimum total assistant content chars needed to keep an episode
   * that the tool-heavy heuristic would otherwise skip. Default 80.
   */
  minAssistantCharsForToolHeavy: number;
}

// ─── User feedback inputs ──────────────────────────────────────────────────

/**
 * A single user-originated feedback event. `explicit` = user literally said
 * something ("good job" / "no, try X"); `implicit` = inferred from the
 * session flow (follow-up within ε ms is positive; edited artifact is
 * negative; abandonment is −1).
 */
export interface UserFeedback {
  id: FeedbackId;
  episodeId: EpisodeId;
  sessionId: SessionId;
  traceId?: TraceId | null;
  ts: EpochMs;
  /** Channel as stored in the `feedback` table. */
  channel: FeedbackRow["channel"];
  polarity: FeedbackRow["polarity"];
  magnitude: number; // 0..1
  text: string | null;
  rationale: string | null;
}

// ─── Scoring results ───────────────────────────────────────────────────────

export interface HumanScore {
  /** R_human ∈ [-1, 1]. */
  rHuman: number;
  /** Per-axis sub-scores (see V7 §0.6 table). */
  axes: {
    goalAchievement: number;
    processQuality: number;
    userSatisfaction: number;
  };
  /** One-sentence justification from the rubric LLM. */
  reason: string | null;
  /** "llm" when we actually called it, "heuristic" when we fell back. */
  source: "llm" | "heuristic" | "explicit";
  /** Which provider/model served the scoring call, if any. */
  model: string | null;
}

/** Inputs passed to `scoreHuman`. */
export interface HumanScoreInput {
  episodeSummary: TaskSummary;
  feedback: readonly UserFeedback[];
}

export interface TaskSummary {
  episodeId: EpisodeId;
  sessionId: SessionId;
  userQuery: string;
  agentActions: string;
  outcome: string;
  /** Full packed text (≤ summaryMaxChars). */
  text: string;
  /** True when the summary had to drop content to fit. */
  truncated: boolean;
}

// ─── Backprop ──────────────────────────────────────────────────────────────

export interface BackpropInput {
  /** Traces belonging to the episode, in chronological order (small → large ts). */
  traces: readonly TraceRow[];
  /** R_human for the episode. */
  rHuman: number;
  /** Discount factor γ ∈ [0, 1]. */
  gamma: number;
  /** Decay half-life in days (for priority). */
  decayHalfLifeDays: number;
  /** Anchor time for the decay calculation (ms). Defaults to `Date.now()`. */
  now?: EpochMs;
}

export interface BackpropUpdate {
  traceId: TraceId;
  /** V_t ∈ [-1, 1]. */
  value: number;
  /** α carried over from capture (not recomputed). */
  alpha: number;
  /** priority ∝ max(V, 0) · decay(Δt). */
  priority: number;
}

export interface BackpropResult {
  updates: BackpropUpdate[];
  /** Mean |V| over episode — tracked for debugging. */
  meanAbsValue: number;
  /** Max priority (debug). */
  maxPriority: number;
  /** γ / half-life / anchor recorded for audit. */
  echoParams: {
    gamma: number;
    decayHalfLifeDays: number;
    now: EpochMs;
  };
}

// ─── Final pipeline result ─────────────────────────────────────────────────

export interface RewardResult {
  episodeId: EpisodeId;
  sessionId: SessionId;
  /** R_human ∈ [-1, 1]. */
  rHuman: number;
  /** The HumanScore record that produced R_human. */
  humanScore: HumanScore;
  /** Count of feedback rows that contributed to this score. */
  feedbackCount: number;
  /** Backprop summary. */
  backprop: BackpropResult;
  /** Traces that were updated (ids only). */
  traceIds: TraceId[];
  /** Monotonic timings for the run. */
  timings: {
    summary: number;
    score: number;
    backprop: number;
    persist: number;
    total: number;
  };
  /** Non-fatal hiccups that don't stop the run. */
  warnings: Array<{ stage: string; message: string; detail?: Record<string, unknown> }>;
  startedAt: EpochMs;
  completedAt: EpochMs;
}

export interface RewardInput {
  episodeId: EpisodeId;
  /**
   * Feedback items that arrived for this episode. MAY be empty — the
   * pipeline will then fall back to implicit-signals scoring (default
   * neutral if nothing is available).
   */
  feedback: readonly UserFeedback[];
  /**
   * "trigger" is metadata only; it lets downstream subscribers tell
   * whether the run was the automatic window-expired fallback vs. an
   * explicit user reply.
   */
  trigger: "explicit_feedback" | "implicit_fallback" | "manual";
}

// ─── Events ────────────────────────────────────────────────────────────────

export type RewardEvent =
  | { kind: "reward.scheduled"; episodeId: EpisodeId; sessionId: SessionId }
  | {
      kind: "reward.scored";
      episodeId: EpisodeId;
      sessionId: SessionId;
      rHuman: number;
      source: HumanScore["source"];
    }
  | { kind: "reward.updated"; result: RewardResult }
  | {
      kind: "reward.failed";
      episodeId: EpisodeId;
      sessionId: SessionId;
      stage: string;
      error: { code: string; message: string };
    };

export type RewardEventKind = RewardEvent["kind"];
export type RewardEventListener = (evt: RewardEvent) => void;
export interface RewardEventBus {
  on(kind: RewardEventKind, fn: RewardEventListener): () => void;
  onAny(fn: RewardEventListener): () => void;
  emit(evt: RewardEvent): void;
  listenerCount(kind?: RewardEventKind): number;
}
