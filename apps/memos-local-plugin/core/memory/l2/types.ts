/**
 * `core/memory/l2` — types.
 *
 * The L2 pipeline maps a freshly-settled episode (reward already applied) to
 * zero or more operations on the `policies` + `l2_candidate_pool` tables:
 *
 * 1. **Associate** — for every trace with V > 0, look up nearby `active` L2
 *    policies by cosine. If one matches and shares the signature, bump its
 *    `support`, recompute `gain`, possibly retire on consistent negative
 *    delta.
 * 2. **Candidate** — for traces that *don't* match any L2, drop them into
 *    `l2_candidate_pool` keyed by their signature (see `signature.ts`).
 * 3. **Induce** — when ≥ 2 traces from **different** episodes share a
 *    candidate-pool signature, call the `l2.induction` prompt and mint a
 *    new `candidate` policy + embedding.
 *
 * All shapes below are *internal* to `core/memory/l2`; they are re-exported
 * selectively by `index.ts`.
 */

import type {
  EpisodeId,
  EpochMs,
  PolicyId,
  PolicyRow,
  SessionId,
  TraceId,
  TraceRow,
} from "../../types.js";

// ─── Config mirror (algorithm.l2Induction + a few hard-coded knobs) ────────

export interface L2Config {
  /** Cosine ≥ this is required to associate a new trace with an existing L2. */
  minSimilarity: number;
  /** TTL (days) for rows in `l2_candidate_pool`. */
  candidateTtlDays: number;
  /** Discount factor γ (shared with reward — used for value-weighted aggregation). */
  gamma: number;
  /** Softmax temperature τ for value-weighted trace aggregation. V7 eq. 3. */
  tauSoftmax: number;
  /** When true, call the LLM to induce new L2 policies; else skip induction. */
  useLlm: boolean;
  /** Minimum trace V (after reward) to consider for any L2 update. */
  minTraceValue: number;
  /** Minimum #distinct episodes required to mint a new L2 policy. */
  minEpisodesForInduction: number;
  /** Character cap for traces passed into the induction prompt. */
  inductionTraceCharCap: number;
}

// ─── Pattern signature ─────────────────────────────────────────────────────

/**
 * A pattern signature compresses a trace into a short string that's stable
 * across semantically similar traces. Same signature → likely the same
 * sub-problem → candidates for joint induction.
 *
 * Format: `<primaryTag>|<secondaryTag>|<tool>|<errCode>`.
 *   - primaryTag: first element of `trace.tags` (e.g. `docker`) or `"_"`
 *   - secondaryTag: second tag (e.g. `pip`) or `"_"`
 *   - tool: first distinct tool called in the trace, normalized (or `"_"`)
 *   - errCode: derived from the first error-bearing observation ("NETWORK_REFUSED", "EXIT_1", …) or `"_"`
 *
 * Example: `"docker|pip|pip.install|MODULE_NOT_FOUND"`.
 */
export type PatternSignature = string;

export interface SignatureComponents {
  primaryTag: string;
  secondaryTag: string;
  tool: string;
  errCode: string;
}

// ─── Association / induction decisions ─────────────────────────────────────

/** Outcome for a single trace when run through the L2 association step. */
export interface AssociationResult {
  traceId: TraceId;
  signature: PatternSignature;
  /** Matched existing policy — null when no cosine/sig match. */
  matchedPolicyId: PolicyId | null;
  /** Match strength (cosine) ∈ [0, 1] when matched. */
  matchSimilarity: number;
  /** True when we added/updated a candidate-pool row for this trace. */
  addedToCandidatePool: boolean;
}

/** Induction decision for a candidate-pool bucket. */
export interface InductionResult {
  signature: PatternSignature;
  /** Null when induction was skipped (too few distinct episodes / LLM disabled). */
  policyId: PolicyId | null;
  /** Number of candidate-pool rows that fed this induction. */
  poolSize: number;
  /** Distinct episodes that contributed evidence. */
  episodeIds: EpisodeId[];
  /** Traces that contributed evidence (same order as episodes). */
  traceIds: TraceId[];
  skippedReason:
    | null
    | "too_few_episodes"
    | "llm_disabled"
    | "llm_failed"
    | "draft_invalid"
    | "duplicate_of"
    | "all_below_threshold";
  /** When `skippedReason === "duplicate_of"`, the existing policy id. */
  duplicateOfPolicyId?: PolicyId | null;
}

// ─── Gain bookkeeping ──────────────────────────────────────────────────────

export interface GainInput {
  policyId: PolicyId;
  /** Traces where the policy was actually applied (positive set). */
  withTraces: readonly TraceRow[];
  /** Traces that solved the same kind of problem *without* the policy. */
  withoutTraces: readonly TraceRow[];
}

export interface GainResult {
  policyId: PolicyId;
  gain: number;
  withMean: number;
  withoutMean: number;
  withCount: number;
  withoutCount: number;
  /** V7 §0.6 eq. 3: softmax(V/τ) mean. Used when `withCount ≥ 3`. */
  weightedWith: number;
}

// ─── Inputs / outputs for the orchestrator ─────────────────────────────────

export interface L2ProcessInput {
  episodeId: EpisodeId;
  sessionId: SessionId;
  /** Traces that belong to this episode — already scored. */
  traces: readonly TraceRow[];
  /** Monotonic anchor for candidate TTL. Defaults to `Date.now()`. */
  now?: EpochMs;
  /**
   * "reward.updated" trigger, for tagging audit events. Defaults to
   * `"manual"` when the caller invokes the orchestrator directly.
   */
  trigger: "reward.updated" | "manual" | "rebuild";
}

export interface L2ProcessResult {
  episodeId: EpisodeId;
  sessionId: SessionId;
  associations: AssociationResult[];
  inductions: InductionResult[];
  /** Policies whose `support`/`gain`/`status` got touched. */
  touchedPolicyIds: PolicyId[];
  /** Non-fatal hiccups we logged but didn't throw on. */
  warnings: Array<{ stage: string; message: string; detail?: Record<string, unknown> }>;
  timings: {
    associate: number;
    candidate: number;
    induce: number;
    gain: number;
    persist: number;
    total: number;
  };
  startedAt: EpochMs;
  completedAt: EpochMs;
}

// ─── LLM draft ─────────────────────────────────────────────────────────────

/** The JSON shape we require from `l2.induction` prompt. */
export interface InductionDraft {
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  rationale: string;
  caveats: string[];
  confidence: number;
  supportTraceIds: TraceId[];
}

export type InductionDraftResult =
  | { ok: true; draft: InductionDraft }
  | { ok: false; reason: "llm_disabled" | "llm_failed" | "draft_invalid"; detail?: string };

// ─── Events ────────────────────────────────────────────────────────────────

export type L2Event =
  | {
      kind: "l2.trace.associated";
      episodeId: EpisodeId;
      traceId: TraceId;
      policyId: PolicyId;
      similarity: number;
    }
  | {
      kind: "l2.candidate.added";
      episodeId: EpisodeId;
      traceId: TraceId;
      signature: PatternSignature;
      candidateId: string;
    }
  | {
      kind: "l2.policy.induced";
      episodeId: EpisodeId;
      policyId: PolicyId;
      signature: PatternSignature;
      evidenceTraceIds: TraceId[];
      evidenceEpisodeIds: EpisodeId[];
      title: string;
    }
  | {
      kind: "l2.policy.updated";
      episodeId: EpisodeId;
      policyId: PolicyId;
      status: PolicyRow["status"];
      support: number;
      gain: number;
    }
  | {
      kind: "l2.failed";
      episodeId: EpisodeId;
      stage: string;
      error: { code: string; message: string };
    };

export type L2EventKind = L2Event["kind"];
export type L2EventListener = (evt: L2Event) => void;

export interface L2EventBus {
  on(kind: L2EventKind, fn: L2EventListener): () => void;
  onAny(fn: L2EventListener): () => void;
  emit(evt: L2Event): void;
  listenerCount(kind?: L2EventKind): number;
}
