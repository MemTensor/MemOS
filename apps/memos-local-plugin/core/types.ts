/**
 * Internal types used inside `core/`. These are richer than the public DTOs
 * (which live in `agent-contract/dto.ts`) because they include things adapters
 * shouldn't see — e.g. raw embeddings, internal scores, lifecycle counters.
 *
 * If you need to expose something to adapters, mirror it into `agent-contract/`
 * first and then re-export from there.
 */

import type {
  EpochMs,
  EpisodeId,
  FeedbackId,
  PolicyId,
  Reward,
  ReflectionAlpha,
  SessionId,
  SkillId,
  ToolCallDTO,
  TraceId,
  ValueScore,
  WorldModelId,
} from "../agent-contract/dto.js";

// ─── Re-exports for convenience ──────────────────────────────────────────────
// (Internal modules import everything from this file rather than reaching
// across into `agent-contract/` directly.)

export type {
  AgentKind,
  EpochMs,
  EpisodeId,
  FeedbackId,
  PolicyId,
  Reward,
  ReflectionAlpha,
  SessionId,
  SkillId,
  ToolCallDTO,
  TraceId,
  ValueScore,
  WorldModelId,
} from "../agent-contract/dto.js";

// ─── Embeddings ──────────────────────────────────────────────────────────────

export type EmbeddingVector = Float32Array;

export interface Embedded<T> {
  value: T;
  vec: EmbeddingVector;
  /** Source string used to derive `vec`, kept for re-embedding on dim changes. */
  source: string;
}

// ─── Memory rows (storage-shaped, before being serialized to DTO) ────────────

export interface TraceRow {
  id: TraceId;
  episodeId: EpisodeId;
  sessionId: SessionId;
  ts: EpochMs;
  userText: string;
  agentText: string;
  /**
   * Short LLM-generated summary of this trace — the form the Memories
   * viewer surfaces (and the form retrieval embeddings index, when
   * present). Falls back to `userText` in both places when null (the
   * summarizer occasionally fails open; rendering side handles that).
   */
  summary?: string | null;
  /**
   * Sharing state. `null` = private / not-shared. `share.scope`
   * mirrors the viewer's `private | public | hub` tri-state. Nothing
   * in the pipeline depends on this — it exists purely so the viewer
   * can annotate rows and make the Hub sync round-trippable.
   */
  share?: {
    scope: "private" | "public" | "hub";
    target?: string | null;
    sharedAt?: EpochMs | null;
  } | null;
  toolCalls: ToolCallDTO[];
  /**
   * Raw LLM "thinking" text captured from the model's assistant
   * message (Claude extended-thinking / pi-ai `ThinkingContent`). Part
   * of the conversation log surfaced in the viewer. NEVER conflated
   * with `reflection`, which is the MemOS plugin's own scoring signal.
   * Nullable because not every provider / every turn produces thinking.
   */
  agentThinking?: string | null;
  /**
   * MemOS-produced post-step reflection — feeds α + backprop. Shown
   * in the trace drawer under a dedicated "Reflection" section but
   * never in the conversation log.
   */
  reflection: string | null;
  value: ValueScore;
  alpha: ReflectionAlpha;
  rHuman: Reward | null;
  priority: number;
  /**
   * V7 §2.6 — coarse domain tags used by retrieval for pre-filtering
   * ("docker", "pip", "plugin", ...). Auto-derived during capture (cheap
   * heuristics: tool name, error code, agent-text token hints). Adapters
   * MAY overwrite via the capture hook. Always stored sorted+deduped.
   */
  tags: string[];
  /**
   * V7 §2.6 — **structural match** signatures. Short, verbatim error
   * fragments (≤ 4, ≤ 160 chars each) extracted by
   * `core/capture/error-signature.ts`. Tier 2 retrieval runs
   * `instr(error_signatures_json, ?)` so a later turn that hits the
   * same error (e.g. `"pg_config: command not found"`) can surface
   * the historical trace even when the embedding diverges.
   *
   * Optional on the write side so older callers / test fixtures that
   * predate V7 §2.6 don't have to supply it. Always written back as an
   * array by storage (default `[]`).
   */
  errorSignatures?: string[];
  vecSummary: EmbeddingVector | null;
  vecAction: EmbeddingVector | null;
  /**
   * Stable group key shared by every L1 trace that came from the same
   * user message. `step-extractor` fills it with the user turn's `ts`
   * (epoch ms); the viewer collapses traces with identical
   * `(episodeId, turnId)` into a single "one round = one memory"
   * card. Algorithm-side machinery (V/α/L2/Tier 2) ignores this
   * field — it is purely a UI grouping anchor.
   */
  turnId: EpochMs;
  /** Schema version that wrote this row (helps with migrations). */
  schemaVersion: number;
}

export interface PolicyRow {
  id: PolicyId;
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  support: number;
  gain: number;
  status: "candidate" | "active" | "archived";
  /** Source episodes that contributed evidence. */
  sourceEpisodeIds: EpisodeId[];
  /** Inducer prompt id, helpful for re-running with newer prompts. */
  inducedBy: string;
  /**
   * V7 §2.4.6 — preference / anti-pattern lines distilled by the
   * decision-repair pipeline. Stored in its own column
   * (`decision_guidance_json`) since migration 001; the repo
   * deserialises directly into this shape, no ad-hoc parsing needed.
   * Empty arrays mean "no guidance learned yet".
   */
  decisionGuidance: { preference: string[]; antiPattern: string[] };
  vec: EmbeddingVector | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  /** Sharing state (migration 009). Mirrors `TraceRow.share`. */
  share?: {
    scope: "private" | "public" | "hub";
    target?: string | null;
    sharedAt?: EpochMs | null;
  } | null;
  /** Last user edit through the viewer's edit modal (migration 009). */
  editedAt?: EpochMs | null;
}

/**
 * V7 §1.1 / §2.4.1 L3 world model: f^(3) = (ℰ, ℐ, C, {f^(2)}).
 *   - `environment` (ℰ)  — topology entries ("what lives where")
 *   - `inference`   (ℐ)  — behavioural rules ("how the env responds")
 *   - `constraints` (C)  — taboos / must-not-do
 * `body` is the rendered markdown form fed to prompts, viewer, embedder.
 */
export interface WorldModelStructure {
  environment: WorldModelStructureEntry[];
  inference: WorldModelStructureEntry[];
  constraints: WorldModelStructureEntry[];
}

export interface WorldModelStructureEntry {
  /** Short label, e.g. `"src/components/"` or `"alpine → musl wheels"`. */
  label: string;
  /** Free-form explanation. */
  description: string;
  /** Optional evidence — trace ids or policy ids contributing to this entry. */
  evidenceIds?: string[];
}

export interface WorldModelRow {
  id: WorldModelId;
  title: string;
  /** Rendered markdown summary, used by prompts + viewer + embedding. */
  body: string;
  /** Structured (ℰ, ℐ, C) triple — see V7 §1.1. */
  structure: WorldModelStructure;
  /** Domain tags, used for Tier-3 pre-filtering. */
  domainTags: string[];
  /** L3 reliability in [0, 1], updated via user feedback. Default 0.5. */
  confidence: number;
  /** Source L2 policies the abstraction leaned on. */
  policyIds: PolicyId[];
  /** Episodes that contributed evidence (audit trail). */
  sourceEpisodeIds: EpisodeId[];
  /** Prompt id + version that abstracted this row. */
  inducedBy: string;
  vec: EmbeddingVector | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  /** L3 abstraction version. Starts at 1 and increments on every L3 merge/rebuild. */
  version: number;
  /**
   * Lifecycle state. `'archived'` rows are kept on disk so the viewer
   * can offer "归档 / 取消归档" without deleting evidence.
   */
  status: "active" | "archived";
  /** Unix-ms when the row was archived (NULL while active). */
  archivedAt?: EpochMs | null;
  /** Sharing state (migration 009). */
  share?: {
    scope: "private" | "public" | "hub";
    target?: string | null;
    sharedAt?: EpochMs | null;
  } | null;
  /** Last user edit through the viewer's edit modal (migration 009). */
  editedAt?: EpochMs | null;
}

export interface SkillRow {
  id: SkillId;
  name: string;
  status: "candidate" | "active" | "archived";
  invocationGuide: string;
  /** Optional structured procedure (JSON-shaped tool sequence). */
  procedureJson: unknown;
  eta: number;
  support: number;
  gain: number;
  /** Trial counters used by `verifier.ts`. */
  trialsAttempted: number;
  trialsPassed: number;
  sourcePolicyIds: PolicyId[];
  sourceWorldModelIds: WorldModelId[];
  /**
   * V7 §2.1 `evidence_anchors` — the L1 traces that justified this
   * skill at crystallisation time. Best-first ordering (matches what
   * `gatherEvidence()` returned). Persisted in `evidence_anchors_json`
   * (migration 014). Always present (default `[]`).
   */
  evidenceAnchors: TraceId[];
  vec: EmbeddingVector | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  /**
   * Monotonic version counter bumped on every rebuild/evolve. Starts at 1
   * when the skill first crystallises. Paired with the `skill_generate` /
   * `skill_evolve` rows in `api_logs` to reconstruct a timeline.
   */
  version: number;
  /** Sharing state (migration 009). */
  share?: {
    scope: "private" | "public" | "hub";
    target?: string | null;
    sharedAt?: EpochMs | null;
  } | null;
  /** Last user edit through the viewer's edit modal (migration 009). */
  editedAt?: EpochMs | null;
  /** Number of successful `skill_get` calls that loaded this skill. */
  usageCount?: number;
  /** Last successful `skill_get` time, or null when never loaded. */
  lastUsedAt?: EpochMs | null;
}

export interface SkillTrialRow {
  id: string;
  skillId: SkillId;
  sessionId: SessionId | null;
  episodeId: EpisodeId;
  traceId: TraceId | null;
  turnId: EpochMs | null;
  toolCallId: string | null;
  status: "pending" | "pass" | "fail" | "unknown";
  createdAt: EpochMs;
  resolvedAt: EpochMs | null;
  evidence: Record<string, unknown>;
}

export interface EpisodeRow {
  id: EpisodeId;
  sessionId: SessionId;
  startedAt: EpochMs;
  endedAt: EpochMs | null;
  traceIds: TraceId[];
  rTask: Reward | null;
  /** "open" | "closed". Open episodes accept new traces. */
  status: "open" | "closed";
}

export interface FeedbackRow {
  id: FeedbackId;
  ts: EpochMs;
  episodeId: EpisodeId | null;
  traceId: TraceId | null;
  channel: "explicit" | "implicit";
  polarity: "positive" | "negative" | "neutral";
  magnitude: number;
  rationale: string | null;
  raw: unknown;
}

export interface CandidatePoolRow {
  id: string;
  policyId: PolicyId | null;        // null until promoted
  evidenceTraceIds: TraceId[];
  signature: string;                // semantic fingerprint
  similarity: number;
  expiresAt: EpochMs;
}

export interface DecisionRepairRow {
  id: string;
  ts: EpochMs;
  contextHash: string;
  preference: string;
  antiPattern: string;
  /** trace ids that gave us evidence */
  highValueTraceIds: TraceId[];
  lowValueTraceIds: TraceId[];
  validated: boolean;
}

// ─── Algorithm-internal scores ────────────────────────────────────────────────

export interface ScoredItem<T> {
  item: T;
  score: number;
  reasons?: string[]; // optional human-readable score components for debugging
}
