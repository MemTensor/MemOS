/**
 * `core/memory/l3` — types.
 *
 * V7 §1.1 / §2.4.1 L3 世界模型:
 *     f^(3) = (ℰ, ℐ, C, {f^(2)})
 *
 * The L3 pipeline turns a cluster of compatible, reward-weighted L2
 * policies into a **world model** — a compressed description of the
 * environment those policies operate in:
 *
 *   - ℰ environment topology   — "what lives where"
 *   - ℐ inference rules         — "how the env responds"
 *   - C constraints / taboos    — "what you must not do"
 *
 * All shapes here are internal; `index.ts` re-exports only what callers
 * (pipeline orchestrator, viewer, adapters) actually need.
 */

import type {
  EpisodeId,
  EpochMs,
  PolicyId,
  PolicyRow,
  SessionId,
  TraceRow,
  WorldModelId,
  WorldModelRow,
  WorldModelStructure,
} from "../../types.js";

// ─── Config mirror (algorithm.l3Abstraction) ───────────────────────────────

export interface L3Config {
  /** Minimum compatible active L2 policies in a cluster to trigger abstraction. */
  minPolicies: number;
  /** Hard minimum gain for an L2 to be eligible as abstraction evidence. */
  minPolicyGain: number;
  /** Hard minimum support for an L2 to be eligible as abstraction evidence. */
  minPolicySupport: number;
  /** Cosine floor for two L2s to share a cluster. */
  clusterMinSimilarity: number;
  /** Char cap for each L2 body section handed to the prompt. */
  policyCharCap: number;
  /** Char cap for each L1 evidence trace handed to the prompt. */
  traceCharCap: number;
  /** Max L1 evidence traces per policy in the prompt. */
  traceEvidencePerPolicy: number;
  /** When false, buckets are logged but the LLM is not called. */
  useLlm: boolean;
  /** Cooldown in days between L3 runs per domain tag. */
  cooldownDays: number;
  /** Confidence step per positive/negative user feedback. */
  confidenceDelta: number;
  /** World models below this confidence are hidden from Tier-3 retrieval. */
  minConfidenceForRetrieval: number;
}

// ─── Clustering — signature + buckets ──────────────────────────────────────

/**
 * A compact, stable key used to bucket compatible L2 policies. Derived
 * from each policy's primary domain tag plus a rough tool family string
 * (see `cluster.ts`). Example: `"docker|pip"`, `"node|npm"`,
 * `"python|_"`.
 */
export type PolicyClusterKey = string;

export interface PolicyCluster {
  key: PolicyClusterKey;
  /** All policies that landed in this bucket (already passed minGain). */
  policies: PolicyRow[];
  /** Union of domain tags extracted from the cluster's policies. */
  domainTags: string[];
  /** Centroid of the cluster's policy vectors — used for `vec` in the WM. */
  centroidVec: Float32Array | null;
  /** Average gain across the cluster (rough heuristic for priority). */
  avgGain: number;
}

// ─── LLM draft ─────────────────────────────────────────────────────────────

export interface L3AbstractionDraftEntry {
  label: string;
  description: string;
  evidenceIds?: string[];
}

export interface L3AbstractionDraft {
  title: string;
  domainTags: string[];
  environment: L3AbstractionDraftEntry[];
  inference: L3AbstractionDraftEntry[];
  constraints: L3AbstractionDraftEntry[];
  /** Rendered markdown; see prompt. Fallback is generated in `abstract.ts` if LLM omits it. */
  body: string;
  /** [0, 1]; seeds the persisted `confidence`. */
  confidence: number;
  /** Prior world model ids this draft replaces (optional). */
  supersedesWorldIds?: WorldModelId[];
}

export type L3AbstractionDraftResult =
  | { ok: true; draft: L3AbstractionDraft }
  | { ok: false; reason: "llm_disabled" | "llm_failed" | "draft_invalid"; detail?: string };

// ─── Abstraction outcomes ──────────────────────────────────────────────────

export interface AbstractionResult {
  clusterKey: PolicyClusterKey;
  /** Null when the run skipped (see `skippedReason`). */
  worldModelId: WorldModelId | null;
  /** Number of policies fed into the cluster. */
  policyCount: number;
  /** Distinct episodes that contributed evidence. */
  episodeIds: EpisodeId[];
  /** Policy ids that contributed evidence. */
  policyIds: PolicyId[];
  skippedReason:
    | null
    | "too_few_policies"
    | "below_min_gain"
    | "llm_disabled"
    | "llm_failed"
    | "draft_invalid"
    | "cooldown"
    | "no_centroid"
    | "duplicate_of";
  /** When `skippedReason === "duplicate_of"`, the existing WM id. */
  duplicateOfWorldId?: WorldModelId | null;
  /** When a new WM was created; null if we updated an existing one. */
  createdNew?: boolean;
  /** Populated for rows that got merged into an existing WM. */
  mergedIntoWorldId?: WorldModelId | null;
}

// ─── Public input/output for the orchestrator ──────────────────────────────

export interface L3ProcessInput {
  /** Trigger id for audit logs (reward.updated / l2.policy.induced / manual). */
  trigger: "reward.updated" | "l2.policy.induced" | "manual" | "rebuild";
  /** Optional scoping — when set, only run for these domain tags. */
  domainTagsFilter?: string[];
  /** Optional override for test fixtures. */
  now?: EpochMs;
  /** Optional session/episode context (for logs/events only). */
  sessionId?: SessionId;
  /** Optional episode context (for the cooldown key). */
  episodeId?: EpisodeId;
}

export interface L3ProcessResult {
  trigger: L3ProcessInput["trigger"];
  /** One entry per cluster we considered (including skipped). */
  abstractions: AbstractionResult[];
  /** Non-fatal hiccups we logged but didn't throw on. */
  warnings: Array<{ stage: string; message: string; detail?: Record<string, unknown> }>;
  timings: {
    cluster: number;
    abstract: number;
    persist: number;
    total: number;
  };
  startedAt: EpochMs;
  completedAt: EpochMs;
}

// ─── Events ────────────────────────────────────────────────────────────────

export type L3Event =
  | {
      kind: "l3.abstraction.started";
      trigger: L3ProcessInput["trigger"];
      clusterCount: number;
    }
  | {
      kind: "l3.world-model.created";
      worldModelId: WorldModelId;
      title: string;
      domainTags: string[];
      policyIds: PolicyId[];
      confidence: number;
    }
  | {
      kind: "l3.world-model.updated";
      worldModelId: WorldModelId;
      title: string;
      domainTags: string[];
      policyIds: PolicyId[];
      confidence: number;
    }
  | {
      kind: "l3.confidence.adjusted";
      worldModelId: WorldModelId;
      previous: number;
      next: number;
      reason: string;
    }
  | {
      kind: "l3.failed";
      stage: string;
      error: { code: string; message: string };
      clusterKey?: PolicyClusterKey;
    };

export type L3EventKind = L3Event["kind"];
export type L3EventListener = (evt: L3Event) => void;

export interface L3EventBus {
  on(kind: L3EventKind, fn: L3EventListener): () => void;
  onAny(fn: L3EventListener): () => void;
  emit(evt: L3Event): void;
  listenerCount(kind?: L3EventKind): number;
}

// ─── Internal helper type aliases ──────────────────────────────────────────

export type { WorldModelRow, WorldModelStructure, TraceRow, PolicyRow };
