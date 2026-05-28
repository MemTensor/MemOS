/**
 * Internal DTOs for `core/capture`.
 *
 * These are the stage-to-stage contracts between:
 *   step-extractor → normalizer → batch-scorer (windowed binary) →
 *   embedder → traces repo
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

/**
 * Fixed-enum values written into `traces.reflection` by the windowed binary
 * reflection pipeline. Anything outside this set is legacy natural-language
 * reflection text from before the 2026-05 redesign.
 */
export const REFLECTION_ENUM_LABELS = new Set<string>([
  "RELATED",
  "PIVOTAL",
  "IRRELEVANT",
  "RELATED_DEFAULT",
]);

/**
 * Return the reflection value only when it carries free-form natural-language
 * signal — the three fixed labels are converted to `null` so downstream
 * consumers don't feed `RELATED_DEFAULT` (or similar) into LLM prompts,
 * keyword blobs, or error-signature heuristics.
 */
export function reflectionAsText(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return REFLECTION_ENUM_LABELS.has(trimmed) ? null : value;
}

export interface ReflectionScore {
  /** The final reflection text (may differ from `rawReflection` if synthed). */
  text: string | null;
  /** The LLM α score ∈ [0, 1]. Null when alpha-scoring is disabled / skipped. */
  alpha: number | null;
  /** LLM `usable` flag: false → alpha forced to 0 per V7 eq. 5. */
  usable: boolean;
  /** Optional LLM explanation for the α/usable decision. */
  reason?: string | null;
  /** Source of the reflection text. */
  source: "adapter" | "extracted" | "synth" | "none";
  /** Optional LLM servedBy model label for audit. */
  model?: string;
}

export type ReflectionContextMode = "none" | "task" | "downstream" | "task_downstream";
export type LongEpisodeReflectMode = "per_step_parallel" | "per_step_downstream";

export interface DownstreamStepPreview {
  /** Relative position from the current step: 1 => step+1, 2 => step+2. */
  offset: 1 | 2 | 3;
  /** `text` means conversational content; `tooluse` means tool output evidence. */
  kind: "text" | "tooluse";
  /** For `text`, the standalone downstream text block. */
  text?: string;
  /** For `tooluse`, one or more tool names observed in that downstream step. */
  toolNames?: string[];
  /** For `tooluse`, summarized output from the downstream tool call(s). */
  toolOutput?: string;
  /** Existing adapter/extracted reflection only; never depends on this run's synth. */
  reflection?: string | null;
}

export interface ReflectionContext {
  taskSummary?: string | null;
  downstream?: DownstreamStepPreview[];
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
  /** Reflection mode. "windowed" enforces fixed-size episode windows only. */
  batchMode: "windowed";
  /** Retained for backward config compatibility; ignored by windowed mode. */
  batchThreshold: number;
  /**
   * Controls which extra context is included in per-step reflection and α
   * prompts. Defaults to "task"; downstream preview remains opt-in.
   */
  reflectionContextMode: ReflectionContextMode;
  /**
   * Long episodes can stay legacy parallel per-step, or enrich each per-step
   * prompt with a precomputed step+1..step+3 preview while remaining parallel.
   */
  longEpisodeReflectMode: LongEpisodeReflectMode;
  /** Max downstream steps attached to a per-step prompt (0..3). */
  downstreamStepCount: number;
  /** Character cap for the task-context block. */
  taskContextMaxChars: number;
  /** Total character cap for all downstream preview blocks. */
  downstreamContextMaxChars: number;
  /** Character cap for each downstream preview block. */
  downstreamPerStepMaxChars: number;
  /** Character cap for current-step outcome in synth / alpha prompts. */
  synthOutcomeMaxChars: number;
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
