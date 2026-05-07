/**
 * Internal DTOs for the Tier-1/2/3 retrieval pipeline.
 *
 * These types are intentionally private to `core/retrieval` — public callers
 * consume the `InjectionPacket` DTO from `agent-contract/dto.ts` via one of
 * the `retrieve.ts` entry functions.
 */

import type {
  AgentKind,
  EpisodeId,
  InjectionPacket,
  InjectionSnippet,
  RepairCtx,
  RetrievalReason,
  SessionId,
  ToolDrivenCtx,
  TurnStartCtx,
  EpochMs,
  RuntimeNamespace,
} from "../../agent-contract/dto.js";

import type {
  EmbeddingVector,
  FeedbackId,
  PolicyId,
  PolicyRow,
  SkillId,
  TraceId,
  WorldModelId,
  ValueScore,
} from "../types.js";

// ─── Tier identifiers ────────────────────────────────────────────────────────

/** The three cost/benefit tiers; internal use only. */
export type TierKind = "tier1" | "tier2" | "tier3";

/** Which `vec_*` column on `traces` a Tier-2 hit came from. */
export type TraceVecKind = "summary" | "action";

// ─── Raw candidates produced by each tier ────────────────────────────────────

/**
 * A "candidate" is what a tier returns *before* fusion/MMR. It carries the
 * raw cosine plus any tier-specific metadata needed for re-ranking.
 */
/**
 * Channels that may contribute a hit. Tracked per candidate so the
 * ranker can RRF-fuse across channels and so logs/Logs view can show
 * "matched via vector + fts" for each snippet.
 */
export type RetrievalChannel =
  | "vec_summary"
  | "vec_action"
  | "vec"
  | "fts"
  | "pattern"
  | "structural";

/** Per-channel rank carried on a candidate, used by the RRF pass. */
export interface ChannelRank {
  channel: RetrievalChannel;
  /** 0-based rank within the channel (lower = better). */
  rank: number;
  /** Raw channel score (cosine for vec, reciprocal-rank for fts/pattern). */
  score: number;
}

export interface TierCandidateBase {
  /** Stable snippet id — primary key in its source table. */
  refId: string;
  /** Tier this candidate came from. */
  tier: TierKind;
  /**
   * Best cosine across vector channels, in [-1, 1] (clamped). For
   * keyword-only hits this is `0` — the candidate then gets its
   * "relevance" entirely from the channel-rank RRF.
   */
  cosine: number;
  /** When the underlying row was written. */
  ts: EpochMs;
  /** Used for MMR redundancy against already-selected snippets. */
  vec: EmbeddingVector | null;
  /**
   * One entry per channel that contributed this candidate. Multiple
   * channels indicating the same row → bigger RRF lift.
   *
   * Optional so legacy callers / unit tests can still construct
   * candidates with just `vec` cosine; the ranker defensively defaults
   * to `[]` and falls back to cosine-only relevance.
   */
  channels?: ChannelRank[];
  /** Free-form debug blob echoed back through events/logs. */
  debug?: Record<string, unknown>;
}

/** Skill lifecycle label (mirrors `SkillRow["status"]`). */
export type SkillStatus = "candidate" | "active" | "archived";

/** Tier 1 — a matched Skill. */
export interface SkillCandidate extends TierCandidateBase {
  tier: "tier1";
  refKind: "skill";
  refId: SkillId;
  skillName: string;
  eta: number;
  status: SkillStatus;
  invocationGuide: string;
  sourcePolicyIds?: PolicyId[];
  updatedAt?: EpochMs;
}

/** Tier 2a — a single high-value trace. */
export interface TraceCandidate extends TierCandidateBase {
  tier: "tier2";
  refKind: "trace";
  refId: TraceId;
  value: ValueScore;
  priority: number;
  episodeId: EpisodeId;
  sessionId: SessionId;
  /** Which vector column this hit came from (summary vs action). */
  vecKind: TraceVecKind;
  userText: string;
  agentText: string;
  /**
   * LLM-generated summary line (same string stored in
   * `traces.summary`). `null` when the summarizer failed open. When
   * present, renderers prefer it over `userText` — keeps the
   * injection block skim-able.
   */
  summary: string | null;
  reflection: string | null;
  tags: string[];
}

/** Tier 2b — a grouped episode summary (synthesised from the best trace). */
export interface EpisodeCandidate extends TierCandidateBase {
  tier: "tier2";
  refKind: "episode";
  refId: EpisodeId;
  sessionId: SessionId;
  /** Summary text synthesised from the top traces of this episode. */
  summary: string;
  /** Max value of any trace rolled up into this summary. */
  maxValue: ValueScore;
  meanPriority: number;
}

/** Tier 2c - a typed user-feedback experience. */
export interface ExperienceCandidate extends TierCandidateBase {
  tier: "tier2";
  refKind: "experience";
  refId: PolicyId;
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  support: number;
  gain: number;
  status: "candidate" | "active" | "archived";
  experienceType: NonNullable<PolicyRow["experienceType"]>;
  evidencePolarity: NonNullable<PolicyRow["evidencePolarity"]>;
  salience: number;
  confidence: number;
  skillEligible: boolean;
  sourceEpisodeIds: EpisodeId[];
  sourceFeedbackIds: FeedbackId[];
  sourceTraceIds: TraceId[];
  decisionGuidance: { preference: string[]; antiPattern: string[] };
  updatedAt: EpochMs;
}

/** Tier 3 — a matched world-model snippet. */
export interface WorldModelCandidate extends TierCandidateBase {
  tier: "tier3";
  refKind: "world-model";
  refId: WorldModelId;
  /** Short label (e.g. "docker-compose"). */
  title: string;
  /** Full world-model body — environment topology + inference rules. */
  body: string;
  /** Associated L2 policy ids (surfaced for cross-referencing). */
  policyIds: string[];
}

export type TierCandidate =
  | SkillCandidate
  | TraceCandidate
  | EpisodeCandidate
  | ExperienceCandidate
  | WorldModelCandidate;

// ─── Ranker / fused snippets ────────────────────────────────────────────────

/**
 * A candidate promoted to the final snippet list, after fusion+MMR.
 * `finalScore` is monotone-decreasing down the `snippets` array.
 */
export interface RankedSnippet {
  snippet: InjectionSnippet;
  tier: TierKind;
  /** Monotone score used by MMR (blend of cosine & V·decay). */
  relevance: number;
  /** MMR-penalised score ≤ relevance (same shape — tie-break by input order). */
  finalScore: number;
  /** The raw candidate this snippet was minted from (for debug/logging). */
  origin: TierCandidate;
}

// ─── Config + dependencies ──────────────────────────────────────────────────

/**
 * Snapshot of `algorithm.retrieval.*` — we accept a plain object so tests can
 * build minimal configs without standing up the TypeBox defaults.
 */
export interface RetrievalConfig {
  tier1TopK: number;
  tier2TopK: number;
  tier3TopK: number;

  candidatePoolFactor: number;
  weightCosine: number;
  weightPriority: number;
  mmrLambda: number;
  includeLowValue: boolean;
  rrfConstant: number;
  minSkillEta: number;
  minTraceSim: number;
  tagFilter: "auto" | "off" | "strict";

  /** Per-tier keyword (FTS + pattern) channel size. Default 20. */
  keywordTopK?: number;
  /**
   * Drop candidates with `relevance < topRelevance · this`. 0 disables
   * the relative cutoff. Default 0.4.
   */
  relativeThresholdFloor?: number;
  /**
   * Tier-1 skill relevance blend = `weightCosine · cos + skillEtaBlend · η`.
   * Defaults to 0.15 (cosine dominates, η is just a nudge).
   */
  skillEtaBlend?: number;
  /**
   * Smart MMR seeding — only seed a tier if its best candidate clears
   * `topRelevance · smartSeedRatio` (see below). Default true.
   * `smartSeed: false` restores the legacy "seed best of every non-empty
   * tier" behaviour regardless of relevance.
   */
  smartSeed?: boolean;
  /**
   * When `smartSeed` is on, only seed a tier whose best candidate's
   * relevance is ≥ `poolTopRelevance · smartSeedRatio`. Default 0.7.
   * Independent of `relativeThresholdFloor` so the seed gate can be
   * stricter than the generic drop floor.
   */
  smartSeedRatio?: number;
  /**
   * If a candidate is surfaced by ≥ 2 channels, bypass the relative
   * threshold (it still participates in MMR). This compensates for
   * the ranker's base formula being "max channel score + additive
   * boosts" — a two-channel agreement is a strong signal even when
   * the absolute score falls below the drop floor. Default true.
   */
  multiChannelBypass?: boolean;

  /**
   * V7 §2.6 Tier-1 rendering mode.
   *   - "summary" (default): inject `name + η + first-line summary +
   *     a `skill_get(id="…")` invocation hint`. Lets the host model
   *     pull the full procedure on demand instead of bloating every
   *     prompt with skills it may never use.
   *   - "full":    inline the full `invocationGuide` body (legacy).
   */
  skillInjectionMode?: "summary" | "full";
  /** Per-skill summary char cap when `skillInjectionMode === "summary"`. */
  skillSummaryChars?: number;

  /**
   * Minimum cosine between the current query and the best trace in a
   * candidate episode for Tier 2b "episode replay" to fire. Below this,
   * we skip the episode rollup entirely — better no reference than a
   * misleading one. Typical range 0.35–0.6.
   */
  episodeGoalMinSim?: number;

  /** Priority decay half-life (mirrors `algorithm.reward.decayHalfLifeDays`). */
  decayHalfLifeDays: number;

  /**
   * LLM-based relevance filter that runs AFTER rank/MMR and BEFORE the
   * packet is rendered. Mirrors the legacy `memos-local-openclaw`
   * `unifiedLLMFilter`: tier retrieval is greedy (cosine similarity),
   * so it's common to see surface-similar but semantically-off
   * candidates. The filter asks a small LLM call to keep only the
   * genuinely relevant ones before injection.
   *
   * When `llmFilterEnabled` is false or the LLM is unavailable, the
   * ranked list is passed through unchanged.
   */
  llmFilterEnabled: boolean;
  /** Keep at most N candidates after the LLM filter. */
  llmFilterMaxKeep: number;
  /** Skip the filter entirely when the ranked list has fewer than this many items. */
  llmFilterMinCandidates: number;
  /**
   * Max chars of body text to show the LLM filter for each candidate.
   * Higher = more context for precise judgement, at the cost of more
   * tokens per round-trip. Default 500 (openclaw uses 300 without
   * tags/channels; we include richer metadata so a slightly bigger
   * window pays for itself).
   */
  llmFilterCandidateBodyChars?: number;
}

/**
 * The minimum surface `core/retrieval` needs from storage. Structural typing
 * lets us pass the real repos in prod and lightweight fakes in unit tests.
 */
export interface RetrievalRepos {
  skills: {
    searchByVector: (
      query: EmbeddingVector,
      k: number,
      opts?: {
        statusIn?: SkillStatus[];
        hardCap?: number;
      },
    ) => Array<{
      id: string;
      score: number;
      meta?: {
        name: string;
        status: SkillStatus;
        eta: number;
        gain: number;
      };
    }>;
    /**
     * FTS5 trigram MATCH against `skills_fts`. Score is reciprocal rank
     * `1 / (idx+1)` so the ranker can fuse via the same RRF pass it
     * uses for cosine hits.
     */
    searchByText?: (
      ftsMatch: string,
      k: number,
      opts?: { statusIn?: SkillStatus[] },
    ) => Array<{
      id: string;
      score: number;
      meta?: {
        name: string;
        status: SkillStatus;
        eta: number;
        gain: number;
      };
    }>;
    /**
     * LIKE pattern fallback for queries that fall below the trigram
     * window (e.g. 2-char Chinese names). Same `meta` shape as the
     * other channels.
     */
    searchByPattern?: (
      terms: readonly string[],
      k: number,
      opts?: { statusIn?: SkillStatus[] },
    ) => Array<{
      id: string;
      score: number;
      meta?: {
        name: string;
        status: SkillStatus;
        eta: number;
        gain: number;
      };
    }>;
    getById: (id: SkillId) => {
      id: SkillId;
      name: string;
      status: SkillStatus;
      invocationGuide: string;
      eta: number;
      sourcePolicyIds?: PolicyId[];
      updatedAt?: EpochMs;
    } | null;
  };

  traces: {
    searchByVector: (
      query: EmbeddingVector,
      k: number,
      opts?: {
        kind?: TraceVecKind;
        where?: string;
        params?: Record<string, unknown>;
        hardCap?: number;
        anyOfTags?: readonly string[];
      },
    ) => Array<{
      id: string;
      score: number;
      meta?: {
        ts: number;
        priority: number;
        value: number;
        episode_id: EpisodeId;
        session_id: SessionId;
        tags_json?: string;
      };
    }>;
    /** FTS5 trigram MATCH against `traces_fts`. */
    searchByText?: (
      ftsMatch: string,
      k: number,
      opts?: { where?: string; params?: Record<string, unknown> },
    ) => Array<{
      id: string;
      score: number;
      meta?: {
        ts: number;
        priority: number;
        value: number;
        episode_id: EpisodeId;
        session_id: SessionId;
        tags_json?: string;
      };
    }>;
    /** LIKE pattern fallback (CJK bigrams + short ASCII). */
    searchByPattern?: (
      terms: readonly string[],
      k: number,
      opts?: { where?: string; params?: Record<string, unknown> },
    ) => Array<{
      id: string;
      score: number;
      meta?: {
        ts: number;
        priority: number;
        value: number;
        episode_id: EpisodeId;
        session_id: SessionId;
        tags_json?: string;
      };
    }>;
    getManyByIds: (ids: readonly TraceId[]) => Array<{
      id: TraceId;
      episodeId: EpisodeId;
      sessionId: SessionId;
      ts: EpochMs;
      userText: string;
      agentText: string;
      /**
       * Optional LLM-generated summary for this trace. Nullable when
       * the summarizer failed open at capture time.
       */
      summary?: string | null;
      reflection: string | null;
      value: number;
      priority: number;
      tags: string[];
      vecSummary: EmbeddingVector | null;
      vecAction: EmbeddingVector | null;
    }>;
    /**
     * V7 §2.6 structural match — exact-substring lookup over stored
     * error signatures. Newest-first, capped at `limit`.
     */
    searchByErrorSignature: (
      anyOfFragments: readonly string[],
      limit: number,
      opts?: {
        where?: string;
        params?: Record<string, unknown>;
      },
    ) => Array<{
      id: TraceId;
      episodeId: EpisodeId;
      sessionId: SessionId;
      ts: EpochMs;
      userText: string;
      agentText: string;
      summary?: string | null;
      reflection: string | null;
      value: number;
      priority: number;
      tags: string[];
      errorSignatures?: string[];
    }>;
  };

  worldModel: {
    searchByVector: (
      query: EmbeddingVector,
      k: number,
      opts?: { hardCap?: number },
    ) => Array<{
      id: string;
      score: number;
      meta?: { title: string };
    }>;
    /** FTS5 trigram MATCH against `world_model_fts`. */
    searchByText?: (
      ftsMatch: string,
      k: number,
      opts?: { minConfidence?: number },
    ) => Array<{
      id: string;
      score: number;
      meta?: { title: string };
    }>;
    /** LIKE pattern fallback. */
    searchByPattern?: (
      terms: readonly string[],
      k: number,
      opts?: { minConfidence?: number },
    ) => Array<{
      id: string;
      score: number;
      meta?: { title: string };
    }>;
    getById: (id: WorldModelId) => {
      id: WorldModelId;
      title: string;
      body: string;
      policyIds: string[];
    } | null;
  };

  /**
   * V7 §2.4.6 — minimal slice of the `policies` repo used to surface
   * `decision_guidance` (preference / anti-pattern). Policies aren't
   * directly tier-ranked; we look them up to attach guidance to the
   * traces / skills already chosen by tiers 1 + 2.
   *
   * `list({status: "active"})` is called once per retrieval pass and
   * the result is filtered in JS by `sourceEpisodeIds` / id matching.
   * Active policy sets are bounded (typically < 200 per install) so
   * the full scan is cheap and avoids a per-trace round-trip.
   *
   * Optional so unit-test fakes that don't care about guidance can
   * skip wiring it. When undefined, retrieval simply emits no
   * decision-guidance section.
   */
  policies?: {
    searchByVector?: (
      query: EmbeddingVector,
      k: number,
      opts?: {
        statusIn?: Array<"candidate" | "active" | "archived">;
        hardCap?: number;
      },
    ) => Array<{
      id: string;
      score: number;
      meta?: {
        title: string;
        status: "candidate" | "active" | "archived";
        support: number;
        gain: number;
        experience_type?: NonNullable<PolicyRow["experienceType"]>;
        evidence_polarity?: NonNullable<PolicyRow["evidencePolarity"]>;
        salience?: number;
        confidence?: number;
      };
    }>;
    list: (filter?: {
      status?: "candidate" | "active" | "archived";
    }) => Array<{
      id: string;
      title: string;
      trigger?: string;
      procedure?: string;
      verification?: string;
      boundary?: string;
      support?: number;
      gain?: number;
      status?: "candidate" | "active" | "archived";
      experienceType?: NonNullable<PolicyRow["experienceType"]>;
      evidencePolarity?: NonNullable<PolicyRow["evidencePolarity"]>;
      salience?: number;
      confidence?: number;
      skillEligible?: boolean;
      sourceEpisodeIds: EpisodeId[];
      sourceFeedbackIds?: FeedbackId[];
      sourceTraceIds?: TraceId[];
      decisionGuidance: { preference: string[]; antiPattern: string[] };
      vec?: EmbeddingVector | null;
      updatedAt?: EpochMs;
    }>;
    getById: (id: string) => {
      id: string;
      title: string;
      trigger?: string;
      procedure?: string;
      verification?: string;
      boundary?: string;
      support?: number;
      gain?: number;
      status?: "candidate" | "active" | "archived";
      experienceType?: NonNullable<PolicyRow["experienceType"]>;
      evidencePolarity?: NonNullable<PolicyRow["evidencePolarity"]>;
      salience?: number;
      confidence?: number;
      skillEligible?: boolean;
      sourceEpisodeIds: EpisodeId[];
      sourceFeedbackIds?: FeedbackId[];
      sourceTraceIds?: TraceId[];
      decisionGuidance: { preference: string[]; antiPattern: string[] };
      vec?: EmbeddingVector | null;
      updatedAt?: EpochMs;
    } | null;
  };
}

/** Abstract embedder surface consumed by retrieval. Mirrors `Embedder`. */
export interface RetrievalEmbedder {
  embed: (text: string, role?: "query" | "document") => Promise<EmbeddingVector>;
}

export interface RetrievalDeps {
  repos: RetrievalRepos;
  embedder: RetrievalEmbedder;
  config: RetrievalConfig;
  namespace: RuntimeNamespace;
  now: () => EpochMs;
  /**
   * Optional LLM used by the post-rank relevance filter
   * (`llm-filter.ts`). Null disables the step; retrieval stays purely
   * mechanical. Kept off the required surface so unit tests can omit
   * it.
   */
  llm?: import("../llm/index.js").LlmClient | null;
}

// ─── Results ─────────────────────────────────────────────────────────────────

/** Summary returned to orchestration callers. */
export interface RetrievalResult {
  packet: InjectionPacket;
  /** Stats useful for logs/metrics/UI. Always populated. */
  stats: RetrievalStats;
}

export interface RetrievalStats {
  reason: RetrievalReason;
  agent: AgentKind;
  sessionId: SessionId;
  episodeId?: EpisodeId;
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  tier1LatencyMs: number;
  tier2LatencyMs: number;
  tier3LatencyMs: number;
  fuseLatencyMs: number;
  totalLatencyMs: number;
  queryTokens: number;
  queryTags: string[];
  emptyPacket: boolean;
  /** Query embedding status. `degraded=true` means vector recall was unavailable. */
  embedding?: {
    attempted: boolean;
    ok: boolean;
    degraded: boolean;
    errorCode?: string;
    errorMessage?: string;
  };
  /**
   * Observability breakdown — populated so the Logs page (and
   * api_logs) can show "how many candidates survived each stage" and
   * operators can spot "this stage is the lossy one" at a glance.
   * All fields are optional so legacy callers / older RetrievalStats
   * consumers keep compiling.
   */
  rawCandidateCount?: number;
  droppedByThresholdCount?: number;
  thresholdFloor?: number;
  topRelevance?: number;
  rankedCount?: number;
  llmFilterOutcome?:
    | "disabled"
    | "no_llm"
    | "below_threshold"
    | "empty_query"
    | "llm_kept_all"
    | "llm_filtered"
    | "llm_failed_safe_cutoff";
  llmFilterSufficient?: boolean;
  llmFilterKept?: number;
  llmFilterDropped?: number;
  /**
   * Channel hit counts across all tiers, e.g.
   * `{ vec_summary: 12, fts: 7, pattern: 3, structural: 0 }`. Helps
   * identify queries that got hits only through one channel (likely
   * fragile).
   */
  channelHits?: Partial<Record<
    | "vec_summary"
    | "vec_action"
    | "vec"
    | "fts"
    | "pattern"
    | "structural",
    number
  >>;
}

/** Discriminated context union — one per entry point in `retrieve.ts`. */
export type RetrievalCtx =
  | ({ reason: "turn_start" } & TurnStartCtx)
  | ({ reason: "tool_driven" } & ToolDrivenCtx)
  | ({ reason: "skill_invoke" } & SkillInvokeCtx)
  | ({ reason: "sub_agent" } & SubAgentCtx)
  | ({ reason: "decision_repair" } & RepairCtx);

/** Called when the host model decides to invoke a specific Skill. */
export interface SkillInvokeCtx {
  agent: AgentKind;
  namespace?: RuntimeNamespace;
  sessionId: SessionId;
  episodeId?: EpisodeId;
  /** Skill id we're about to run (or a free-form query if id unknown). */
  skillId?: SkillId;
  /** Natural-language tool invocation args, for embedding fallback. */
  query: string;
  ts: EpochMs;
}

/** Called when a sub-agent is spawned with a mission query. */
export interface SubAgentCtx {
  agent: AgentKind;
  namespace?: RuntimeNamespace;
  sessionId: SessionId;
  episodeId?: EpisodeId;
  /** The sub-agent mission / system prompt head. */
  mission: string;
  /** Coarse agent profile (e.g. "planner", "coder"). */
  profile?: string;
  ts: EpochMs;
}
