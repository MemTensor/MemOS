/**
 * `core/feedback` — public + internal types for the Decision Repair pipeline.
 *
 * The feedback module does **two** related things that both feed V7 §2.4.6
 * (Decision Repair):
 *
 *   1. **Failure signalling** — track per-tool / per-context failure counts
 *      and raise a "stuck loop" alarm when the count crosses a threshold
 *      inside a short step window. This drives the `repair.triggered` event
 *      the pipeline uses to override the next turn's retrieval plan with
 *      `decision_repair`.
 *
 *   2. **User feedback classification + repair** — when the user says "no,
 *      not like that" or "prefer X over Y", extract a preference /
 *      anti-pattern pair and persist it to `decision_repairs`, grounded in
 *      the high-value and low-value traces of the recent context.
 *
 * The two paths share a final stage (`synthesizeDraft` → persist →
 * attach-to-policy) but have different triggers, so we model them as
 * two orchestrator entry points that share a common `DecisionRepairDeps`.
 *
 * Everything here is *internal* to `core/feedback`; `index.ts` re-exports
 * what the orchestrator and tests need.
 */

import type { EpisodeId, EpochMs, PolicyId, SessionId, TraceId } from "../types.js";

// ─── Config (algorithm.feedback) ──────────────────────────────────────────

export interface FeedbackConfig {
  /**
   * Repair threshold — raise the alarm after this many distinct failures
   * for the same tool/context in the rolling window below. V7 §6.3 example
   * uses ≥3.
   */
  failureThreshold: number;
  /**
   * Rolling window size (number of tool calls). The counter auto-decays
   * once the failure drops out of this window.
   */
  failureWindow: number;
  /**
   * Minimum diff between preferred / avoided mean value for the
   * value-guided comparison to fire. V7 §2.4.6 → `δ ≈ 0.5`.
   */
  valueDelta: number;
  /**
   * Call the LLM to produce the final preference / anti-pattern lines.
   * When false, fall back to a simple template using the most relevant
   * success / failure traces.
   */
  useLlm: boolean;
  /**
   * When true, attach the generated guidance back onto the source L2
   * policies' `decisionGuidance` metadata. Visible via skill retrieval.
   */
  attachToPolicy: boolean;
  /**
   * Cooldown (ms) between repeat repairs for the same context hash.
   * Prevents a thrashing agent from spamming the `decision_repairs` table.
   */
  cooldownMs: number;
  /**
   * Character cap for each trace handed to the repair prompt.
   */
  traceCharCap: number;
  /**
   * Max number of high-value / low-value traces the synthesizer compares.
   */
  evidenceLimit: number;
}

// ─── Failure signalling ────────────────────────────────────────────────────

export interface FailureRecord {
  /** Usually the adapter-normalized tool name (e.g. `pip.install`). */
  toolId: string;
  /** Short context string for grouping (task tag, session). */
  context: string;
  /** Monotonic step counter from the adapter. */
  step: number;
  /** Short reason string (error code / message excerpt). */
  reason: string;
  ts: EpochMs;
  /** Optional — only present when we can correlate the failing trace. */
  traceId?: TraceId;
  sessionId?: SessionId;
  episodeId?: EpisodeId;
}

export interface FailureState {
  toolId: string;
  context: string;
  firstSeen: EpochMs;
  lastSeen: EpochMs;
  windowStart: number;
  occurrences: FailureRecord[];
}

export interface FailureBurst extends FailureState {
  /** A stable hash derived from `${toolId}|${context}` (SHA-1 short). */
  contextHash: string;
  failureCount: number;
}

// ─── User-feedback classification ─────────────────────────────────────────

/**
 * V7 §2.4.3 — the user's relationship to the previous answer. Seven
 * shapes that collectively cover every feedback type the spec calls out:
 *
 *   - `positive`    — "that's great", "works", "可以了"
 *   - `negative`    — "no, wrong", "broken", "不对" (entire answer rejected)
 *   - `correction`  — "it should be X, not Y" (targeted fix, not wholesale)
 *   - `constraint`  — "same direction but also add N" (scope tightens)
 *   - `preference`  — "prefer X over Y" / "use X instead of Y"
 *   - `confusion`   — "not sure what you mean", "why did you do that?"
 *   - `instruction` — imperative next step ("then run the tests")
 *   - `unknown`     — signal too weak
 *
 * The repair orchestrator reacts to `negative` / `correction` /
 * `constraint` / `preference` (all decision-shaping shapes). `positive`
 * raises η on the relevant policies; `confusion` / `instruction` /
 * `unknown` pass through to the UI.
 */
export type UserFeedbackShape =
  | "positive"
  | "negative"
  | "correction"
  | "constraint"
  | "preference"
  | "confusion"
  | "instruction"
  | "unknown";

export interface ClassifiedFeedback {
  shape: UserFeedbackShape;
  /** Confidence ∈ [0, 1]. Used to skip low-signal feedback. */
  confidence: number;
  /** Extracted "prefer X" action, if any. */
  prefer?: string;
  /** Extracted "avoid Y" action, if any. */
  avoid?: string;
  /**
   * For `correction` — the user's explicit "should be …" clause.
   * For `constraint` — the extra constraint ("also …", "must …").
   * Left unset for other shapes.
   */
  correction?: string;
  constraint?: string;
  /** Raw user text (already redacted by caller). */
  text: string;
}

// ─── Decision-repair draft (pre-persist) ──────────────────────────────────

/**
 * Shape returned by `synthesizeDraft`. Callers persist it via
 * `decisionRepairs.insert` after deriving the `id` + `ts`.
 */
export interface DecisionRepairDraft {
  contextHash: string;
  preference: string;
  antiPattern: string;
  highValueTraceIds: TraceId[];
  lowValueTraceIds: TraceId[];
  severity: "info" | "warn";
  confidence: number;
  /** Policies whose `decisionGuidance` should pick up this draft. */
  attachToPolicyIds: PolicyId[];
}

// ─── Orchestrator input / output ──────────────────────────────────────────

export type RepairTrigger =
  | "failure-burst"
  | "user.negative"
  | "user.preference"
  | "manual";

export interface RepairInput {
  trigger: RepairTrigger;
  contextHash: string;
  /**
   * Tool identifier that prompted the burst (when `trigger === "failure-burst"`).
   */
  toolId?: string;
  /**
   * Raw user feedback text (when the trigger is user-driven).
   */
  userText?: string;
  sessionId?: SessionId;
  episodeId?: EpisodeId;
  /** Failure records (filled automatically by the signals module). */
  failures?: FailureRecord[];
}

export interface RepairResult {
  trigger: RepairTrigger;
  contextHash: string;
  repairId: string | null;
  draft: DecisionRepairDraft | null;
  skipped: boolean;
  skippedReason?: string;
  startedAt: EpochMs;
  completedAt: EpochMs;
}

// ─── Events ───────────────────────────────────────────────────────────────

export type FeedbackEvent =
  | {
      kind: "repair.triggered";
      at: EpochMs;
      contextHash: string;
      trigger: RepairTrigger;
      failureCount?: number;
    }
  | {
      kind: "repair.persisted";
      at: EpochMs;
      contextHash: string;
      repairId: string;
      confidence: number;
      severity: "info" | "warn";
    }
  | {
      kind: "repair.skipped";
      at: EpochMs;
      contextHash: string;
      trigger: RepairTrigger;
      reason: string;
    }
  | {
      kind: "repair.attached";
      at: EpochMs;
      repairId: string;
      policyIds: PolicyId[];
    }
  | {
      kind: "feedback.classified";
      at: EpochMs;
      shape: UserFeedbackShape;
      confidence: number;
    };

export type FeedbackEventKind = FeedbackEvent["kind"];
export type FeedbackEventListener = (evt: FeedbackEvent) => void;

export interface FeedbackEventBus {
  on(kind: FeedbackEventKind, fn: FeedbackEventListener): () => void;
  onAny(fn: FeedbackEventListener): () => void;
  emit(evt: FeedbackEvent): void;
  listenerCount(kind?: FeedbackEventKind): number;
}
