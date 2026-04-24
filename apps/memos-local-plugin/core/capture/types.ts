/**
 * Internal DTOs for `core/capture`.
 *
 * These are the stage-to-stage contracts between:
 *   step-extractor → normalizer → reflection-extractor → (reflection-synth?)
 *                 → alpha-scorer → embedder → traces repo
 *
 * Not exported through the plugin's public surface (adapters don't care).
 * Exposed to Phase 15 via the pipeline event bus as `CaptureResult` so the
 * orchestrator can chain reward / l2.incremental onto it.
 */

import type { EpisodeId, SessionId, TraceId } from "../../agent-contract/dto.js";
import type { ToolCallDTO } from "../../agent-contract/dto.js";
import type { EmbeddingVector, EpochMs } from "../types.js";
import type { EpisodeSnapshot } from "../session/types.js";

// ─── Stage 1: raw candidate from an EpisodeSnapshot ─────────────────────────

/**
 * One "agent step" in an episode. Always triggered by a **user turn** or
 * a **tool result** preceding the assistant turn. Sub-agent hops produce
 * their own StepCandidate rows with `depth > 0` and `isSubagent = true`.
 *
 * The extractor emits these in episode-ts order. The normalizer may later
 * merge adjacent candidates or drop duplicates.
 */
export interface StepCandidate {
  /** Stable key for dedup / logging within one capture run. */
  key: string;
  /** When the assistant completed this step (end of the assistant turn). */
  ts: EpochMs;
  /** What the user / upstream observation said at the start of this step. */
  userText: string;
  /** What the assistant produced as its answer / tool-calling preamble. */
  agentText: string;
  /**
   * Raw LLM-produced thinking text for this step (Claude extended-thinking,
   * pi-ai `ThinkingContent`). Belongs to the conversation log shown to
   * the user — distinct from `rawReflection`, which is the MemOS
   * plugin's own scoring signal. Optional so legacy fixtures + adapters
   * that don't surface thinking still satisfy the type.
   */
  agentThinking?: string | null;
  /** Tool calls bundled into this step, with inputs + outputs. */
  toolCalls: ToolCallDTO[];
  /** Reflection string lifted from assistant turn meta or text, if any. */
  rawReflection: string | null;
  /** Depth relative to the root episode (0 = top-level, 1+ = nested sub-agent). */
  depth: number;
  /** True if this step came from a sub-agent hop. */
  isSubagent: boolean;
  /** Optional free-form hints from the adapter (session-specific). */
  meta: Record<string, unknown>;
}

// ─── Stage 2: normalized candidate (after truncation + dedup) ───────────────

export interface NormalizedStep extends StepCandidate {
  /** Whether the normalizer truncated any of {userText, agentText, toolCalls}. */
  truncated: boolean;
}

// ─── Stage 3: with a scored reflection ──────────────────────────────────────

export interface ReflectionScore {
  /** The final reflection text (may differ from `rawReflection` if synthed). */
  text: string | null;
  /** The LLM α score ∈ [0, 1]. Null when alpha-scoring is disabled / skipped. */
  alpha: number | null;
  /** LLM `usable` flag: false → alpha forced to 0 per V7 eq. 5. */
  usable: boolean;
  /** Source of the reflection text. */
  source: "adapter" | "extracted" | "synth" | "none";
  /** Optional LLM servedBy model label for audit. */
  model?: string;
}

export interface ScoredStep extends NormalizedStep {
  reflection: ReflectionScore;
}

// ─── Stage 4: fully hydrated row about to be inserted ───────────────────────

export interface TraceCandidate extends ScoredStep {
  traceId: TraceId;
  /**
   * Short domain labels used by retrieval Tier-2 for pre-filtering
   * (sorted, lowercase, deduped). Derived heuristically from tool names,
   * error codes and agent text.
   */
  tags: string[];
  vecSummary: EmbeddingVector | null;
  vecAction: EmbeddingVector | null;
}

// ─── Final result emitted after a capture run ───────────────────────────────

export interface CaptureResult {
  episodeId: EpisodeId;
  sessionId: SessionId;
  /** IDs of the trace rows inserted (in ts order). */
  traceIds: TraceId[];
  /** Steps we produced, for downstream consumers (reward / l2.incremental). */
  traces: TraceCandidate[];
  /** Epoch ms when capture started (kickoff). */
  startedAt: EpochMs;
  /** Epoch ms when traces were persisted. */
  completedAt: EpochMs;
  /** Wall-clock durations for each sub-stage. */
  stageTimings: {
    extract: number;
    normalize: number;
    reflect: number;
    alpha: number;
    /**
     * Time spent by the Phase 3.5 summarizer (LLM + heuristic
     * fallback). Exposed so analytics can flag slow providers.
     */
    summarize: number;
    embed: number;
    persist: number;
  };
  /** How many LLM calls we made this run. */
  llmCalls: {
    /**
     * Per-step reflection synthesis calls. In batch mode this stays at 0;
     * batched calls are counted in `batchedReflection` instead.
     */
    reflectionSynth: number;
    /**
     * Per-step α scoring calls. In batch mode this stays at 0; batched
     * calls are counted in `batchedReflection` instead.
     */
    alphaScoring: number;
    /**
     * Number of batched reflection+α calls (V7 §3.2 batched variant).
     * Always 0 in `batchMode: "per_step"`; otherwise 0..1 per episode
     * (1 on a clean batch, 0 if we fell back to per-step before issuing).
     */
    batchedReflection?: number;
    /** Optional — capture-side summarizer calls. */
    summarize?: number;
  };
  /** Non-fatal problems surfaced during the run (trace meta). */
  warnings: Array<{ stage: string; message: string; detail?: Record<string, unknown> }>;
}

// ─── Input hook ─────────────────────────────────────────────────────────────

export interface CaptureInput {
  episode: EpisodeSnapshot;
  /**
   * `finalized` (clean topic close) or `abandoned` (timeout / shutdown
   * / explicit drop). Optional in the lite phase where the episode is
   * still open and there's no "closure reason" yet — defaults to
   * `finalized` for downstream consumers that don't care.
   */
  closedBy?: "finalized" | "abandoned";
}

// ─── Capture configuration (resolved) ───────────────────────────────────────

export interface CaptureConfig {
  maxTextChars: number;
  maxToolOutputChars: number;
  embedTraces: boolean;
  alphaScoring: boolean;
  synthReflections: boolean;
  llmConcurrency: number;
  /**
   * V7 §3.2 batched variant. Controls when reflection synthesis + α scoring
   * collapse into ONE LLM call per episode instead of N per-step calls.
   *
   *   - "per_step"    — legacy path; one synth/α call per step. Predictable
   *                     prompt size, slow & costly on long episodes.
   *   - "per_episode" — always batch the entire episode into one call.
   *                     Long episodes risk overflowing the model context.
   *   - "auto"        — batch when `stepCount ≤ batchThreshold`; otherwise
   *                     fall back to per-step. Recommended default.
   *
   * Either way, `R_human` (the terminal reward) is computed independently
   * by `core/reward` after user feedback arrives — batching only affects
   * capture-stage LLM usage.
   */
  batchMode: "per_step" | "per_episode" | "auto";
  /**
   * In `batchMode: "auto"`, episodes with strictly more than this many
   * normalized steps fall back to the per-step path. Acts as a guard
   * against prompt-window overflow on very long agent traces.
   */
  batchThreshold: number;
}

// ─── Capture event types (published on their own bus) ──────────────────────
//
// Capture events live on a dedicated bus instead of the SessionEventBus so
// the session layer's event union stays closed and stable. The orchestrator
// (Phase 15) bridges session.* and capture.* into a unified stream before
// handing them off to the viewer / Phase 7 reward pipeline.

export type CaptureEvent =
  | { kind: "capture.started"; episodeId: EpisodeId; sessionId: SessionId }
  | { kind: "capture.lite.done"; result: CaptureResult }
  | { kind: "capture.done"; result: CaptureResult }
  | {
      kind: "capture.failed";
      episodeId: EpisodeId;
      sessionId: SessionId;
      stage: string;
      error: { code: string; message: string };
    };

export type CaptureEventKind = CaptureEvent["kind"];

export type CaptureEventListener = (evt: CaptureEvent) => void;

export interface CaptureEventBus {
  on(kind: CaptureEventKind, fn: CaptureEventListener): () => void;
  onAny(fn: CaptureEventListener): () => void;
  emit(evt: CaptureEvent): void;
  listenerCount(kind?: CaptureEventKind): number;
}
