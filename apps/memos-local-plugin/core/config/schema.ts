/**
 * The single schema for `config.yaml`. Used to:
 *   1. Validate user files at load time (`loadConfig`).
 *   2. Provide JSON Schema for editor autocomplete (writer can emit it).
 *   3. Generate the `templates/config.<agent>.yaml` defaults during code review.
 *
 * Adding fields: provide a default in `defaults.ts` (so old configs upgrade).
 * Removing fields: log a warning at load time; don't crash.
 */

import { Type, type Static } from "@sinclair/typebox";

// ─── Reusable building blocks ───────────────────────────────────────────────

const StringWithDefault = (def = "") => Type.String({ default: def });
const Bool = (def: boolean) => Type.Boolean({ default: def });
const NumberInRange = (def: number, min?: number, max?: number) =>
  Type.Number({ default: def, ...(min != null ? { minimum: min } : {}), ...(max != null ? { maximum: max } : {}) });

// ─── Sub-schemas ────────────────────────────────────────────────────────────

const ViewerSchema = Type.Object({
  port: NumberInRange(18799, 1, 65535),
  bindHost: StringWithDefault("127.0.0.1"),
  openOnFirstTurn: Bool(false),
}, { default: {} });

const BridgeSchema = Type.Object({
  port: NumberInRange(18911, 1, 65535),
  mode: Type.Union([Type.Literal("stdio"), Type.Literal("tcp")], { default: "stdio" }),
}, { default: {} });

const EmbeddingSchema = Type.Object({
  provider: Type.Union([
    Type.Literal("local"),
    Type.Literal("openai_compatible"),
    Type.Literal("gemini"),
    Type.Literal("cohere"),
    Type.Literal("voyage"),
    Type.Literal("mistral"),
  ], { default: "local" }),
  endpoint: StringWithDefault(""),
  model: StringWithDefault("Xenova/all-MiniLM-L6-v2"),
  dimensions: NumberInRange(384, 1, 8192),
  apiKey: StringWithDefault(""),
  cache: Type.Object({
    enabled: Bool(true),
    maxItems: NumberInRange(20_000, 0),
  }, { default: {} }),
}, { default: {} });

const LlmSchema = Type.Object({
  provider: Type.Union([
    Type.Literal("local_only"),
    Type.Literal("openai_compatible"),
    Type.Literal("anthropic"),
    Type.Literal("gemini"),
    Type.Literal("bedrock"),
    Type.Literal("host"),
  ], { default: "local_only" }),
  endpoint: StringWithDefault(""),
  model: StringWithDefault(""),
  temperature: NumberInRange(0, 0, 2),
  /** When true, fall back to the agent host's LLM if `provider` fails. */
  fallbackToHost: Bool(true),
  apiKey: StringWithDefault(""),
  /** Per-call timeout in ms. */
  timeoutMs: NumberInRange(45_000, 1_000),
  /** Max retries on transient errors. */
  maxRetries: NumberInRange(3, 0, 10),
}, { default: {} });

/**
 * Dedicated model slot for the **skill evolver** (V7 Phase 11 skill
 * crystallisation + Phase 10 L2 induction). Often the operator wants
 * a more capable model here than for the per-turn summarizer because
 * skill generation writes code that will be invoked by the agent.
 *
 * All fields are optional. When `model` is empty we fall back to the
 * main `llm.*` settings — this matches the legacy plugin's "使用
 * Summarizer" button and keeps fresh installs zero-config.
 */
const SkillEvolverSchema = Type.Object({
  provider: Type.Union([
    Type.Literal(""),
    Type.Literal("openai_compatible"),
    Type.Literal("anthropic"),
    Type.Literal("gemini"),
    Type.Literal("bedrock"),
  ], { default: "" }),
  endpoint: StringWithDefault(""),
  model: StringWithDefault(""),
  apiKey: StringWithDefault(""),
  temperature: NumberInRange(0, 0, 2),
  timeoutMs: NumberInRange(60_000, 1_000),
}, { default: {} });

const AlgorithmSchema = Type.Object({
  capture: Type.Object({
    /** Cap on agent/user text length (chars). Longer content is summarized. */
    maxTextChars: NumberInRange(4_000, 200, 64_000),
    /** Maximum tool outputs we keep verbatim per step. Extras are truncated. */
    maxToolOutputChars: NumberInRange(2_000, 200, 32_000),
    /** Embed state+action vectors when writing traces. Default on. */
    embedTraces: Bool(true),
    /** When true, ask the LLM to score α for each reflection. Default on. */
    alphaScoring: Bool(true),
    /** Synthesize reflections with the LLM if extractor found none. Default off. */
    synthReflections: Bool(false),
    /** Concurrency for α scoring + synth LLM calls (per_step mode only). */
    llmConcurrency: NumberInRange(4, 1, 32),
    /**
     * V7 §3.2 batched variant. When/how to fold per-step reflection synth +
     * α scoring into one episode-level LLM call:
     *   - "per_step"    : legacy path, N per-step LLM calls
     *   - "per_episode" : always batch
     *   - "auto"        : batch when stepCount ≤ batchThreshold, else per-step
     */
    batchMode: Type.Union(
      [Type.Literal("per_step"), Type.Literal("per_episode"), Type.Literal("auto")],
      { default: "auto" },
    ),
    /**
     * Step-count cap for "auto" mode. Episodes above this limit fall back
     * to per-step calls so the batched prompt cannot overflow context.
     */
    batchThreshold: NumberInRange(12, 1, 64),
  }, { default: {} }),
  reward: Type.Object({
    /** V7 §0.6 eq. 4/5: discount factor γ for reflection-weighted backprop. */
    gamma: NumberInRange(0.9, 0, 1),
    /** V7 §2.4.5 eq. 3: temperature τ for softmax reweighting in L2 induction. */
    tauSoftmax: NumberInRange(0.5, 0.01, 10),
    /** V7 §3.3: priority decay half-life in days. */
    decayHalfLifeDays: NumberInRange(30, 1, 365),
    /** Ask LLM to score user feedback → R_human. Off falls back to polarity heuristics. */
    llmScoring: Bool(true),
    /** Auto-trigger backprop when R_human ≥ this from implicit signals. */
    implicitThreshold: NumberInRange(0.2, 0, 1),
    /**
     * Seconds to wait for explicit user feedback after `capture.done` before
     * falling back to implicit-signals scoring. 0 disables the timer.
     */
    feedbackWindowSec: NumberInRange(600, 0, 86_400),
    /** Max characters for the task summary fed into the human-scorer LLM. */
    summaryMaxChars: NumberInRange(2_000, 200, 16_000),
    /** Concurrency for human-scoring LLM calls. */
    llmConcurrency: NumberInRange(2, 1, 16),
    /**
     * Min user↔assistant *exchanges* before an episode is scored.
     * Shorter episodes are closed as abandoned. Default 2 ≈ "at least
     * one real back-and-forth" (legacy memos-local-openclaw rule).
     */
    minExchangesForCompletion: NumberInRange(2, 1, 20),
    /**
     * Min combined user+assistant content characters before scoring.
     * Filters trivial turns ("hi"/"ok"). Default 80 — cheap threshold
     * that still accepts short CJK prompts.
     */
    minContentCharsForCompletion: NumberInRange(80, 0, 4_000),
  }, { default: {} }),
  l2Induction: Type.Object({
    /** Cosine ≥ this to associate a new trace with an existing L2 policy. */
    minSimilarity: NumberInRange(0.72, 0, 1),
    /** TTL (days) for unpromoted rows in `l2_candidate_pool`. */
    candidateTtlDays: NumberInRange(30, 1),
    /** Min distinct episodes in a candidate bucket before we run induction. */
    minEpisodesForInduction: NumberInRange(2, 2, 20),
    /** Ignore traces whose V is below this floor (prevents noise-driven L2). */
    minTraceValue: NumberInRange(0.01, -1, 1),
    /** When true, call the LLM to induce policies; else collect candidates only. */
    useLlm: Bool(true),
    /** Character cap for traces handed into the `l2.induction` prompt. */
    traceCharCap: NumberInRange(3_000, 600, 16_000),
    /** Archive active policies whose gain dips below this value. */
    archiveGain: NumberInRange(-0.05, -1, 1),
  }, { default: {} }),
  l3Abstraction: Type.Object({
    /** Minimum number of compatible active L2 policies to trigger an L3 abstraction. */
    minPolicies: NumberInRange(2, 2, 50),
    /** Hard minimum gain for an L2 to be eligible as abstraction evidence. */
    minPolicyGain: NumberInRange(0.02, -1, 1),
    /** Hard minimum support for an L2 to be eligible as abstraction evidence. */
    minPolicySupport: NumberInRange(1, 1),
    /**
     * Cosine ≥ this between two L2 vectors → same bucket. Buckets below this
     * are ignored (policies too disparate to share a world model).
     */
    clusterMinSimilarity: NumberInRange(0.6, 0, 1),
    /** Chars of L2 body handed to `l3.abstraction`. */
    policyCharCap: NumberInRange(800, 200, 4_000),
    /** Chars of trace body handed per evidence trace. */
    traceCharCap: NumberInRange(500, 100, 4_000),
    /** Max evidence traces in the prompt — one per policy. */
    traceEvidencePerPolicy: NumberInRange(1, 0, 4),
    /**
     * When true, call `l3.abstraction` to generate/update world models.
     * When false, buckets are logged but no LLM call fires — useful for
     * cost-sensitive deployments.
     */
    useLlm: Bool(true),
    /** Cooldown in days between L3 runs for the same domain tag. */
    cooldownDays: NumberInRange(1, 0, 365),
    /** Confidence delta per positive/negative user feedback. */
    confidenceDelta: NumberInRange(0.05, 0, 1),
    /** Below this confidence, a world model is hidden from Tier-3 retrieval. */
    minConfidenceForRetrieval: NumberInRange(0.2, 0, 1),
  }, { default: {} }),
  skill: Type.Object({
    minSupport: NumberInRange(2, 1),
    // V7 §2.5 graduation floor. The schema allows negative values so
    // demo / single-success-line scenarios (where with-without ≈ 0 by
    // construction even after Bayesian shrinkage) can still force-
    // graduate candidate policies into active. Production default is
    // 0.02 — see `core/config/defaults.ts` for rationale and
    // `core/memory/l2/gain.ts` for how gain is now anchored to a
    // neutral 0.5 baseline so this floor is reachable on real data.
    minGain: NumberInRange(0.02, -1, 1),
    /** Trials a skill must accumulate in `candidate` before it can graduate. */
    candidateTrials: NumberInRange(3, 1),
    /** Back-off before we retry a failed-to-verify policy. */
    cooldownMs: NumberInRange(6 * 60 * 60 * 1000, 0, 30 * 24 * 60 * 60 * 1000),
    /** Chars per evidence trace fed into the crystallize prompt. */
    traceCharCap: NumberInRange(500, 100, 4_000),
    /** Max evidence traces per policy given to the LLM. */
    evidenceLimit: NumberInRange(6, 1, 20),
    /** Turn the LLM crystallization off (collect candidates only). */
    useLlm: Bool(true),
    /** η delta applied per user thumbs up/down. */
    etaDelta: NumberInRange(0.1, 0, 1),
    /** Archive an active skill whose η drops below this. */
    archiveEta: NumberInRange(0.25, 0, 1),
    /** Hide Tier-1 skills whose η is below this. Mirrors retrieval.minSkillEta. */
    minEtaForRetrieval: NumberInRange(0.5, 0, 1),
  }, { default: {} }),
  feedback: Type.Object({
    /** Raise a burst after this many failures of the same tool in-window. */
    failureThreshold: NumberInRange(3, 2, 20),
    /** Rolling window (number of steps) for the burst counter. */
    failureWindow: NumberInRange(5, 2, 50),
    /** Min |mean(high) - mean(low)| to fire without an explicit user signal. */
    valueDelta: NumberInRange(0.5, 0, 2),
    /** Let the LLM rewrite the preference / anti-pattern lines. */
    useLlm: Bool(true),
    /** Tag the L2 policies referenced by the evidence with the guidance. */
    attachToPolicy: Bool(true),
    /** Debounce (ms) for repeat repairs on the same context hash. */
    cooldownMs: NumberInRange(60_000, 0, 24 * 60 * 60 * 1000),
    /** Char cap per trace handed to the repair prompt. */
    traceCharCap: NumberInRange(500, 100, 4_000),
    /** Max evidence traces per class (high-value / low-value). */
    evidenceLimit: NumberInRange(4, 1, 20),
  }, { default: {} }),
  session: Type.Object({
    /**
     * How a user's next message should relate to the previously closed
     * episode. Mirrors V7 §0.1 but softens the default so same-topic
     * follow-ups stay in one "task" from the user's POV.
     *
     *   - "merge_follow_ups" (default)  — both `revision` and `follow_up`
     *     reopen the previous episode and append the new turn. Only
     *     `new_task` opens a fresh episode/session. This matches the
     *     legacy `memos-local-openclaw` behaviour where one "task"
     *     aggregates many related turns and skills crystallise from a
     *     coherent transcript.
     *   - "episode_per_turn"           — follow-ups open a NEW episode in
     *     the same session (V7 §0.1 strict). Each user query gets its
     *     own R_human + V backprop pass. Useful when you want fine-grained
     *     credit assignment per sub-task.
     */
    followUpMode: Type.Union([
      Type.Literal("merge_follow_ups"),
      Type.Literal("episode_per_turn"),
    ], { default: "merge_follow_ups" }),
    /**
     * Hard cap on how long a single merged episode can grow before we
     * force a new episode boundary even if relation says "follow_up".
     * Prevents infinite growth and keeps reward scoring tractable.
     * 0 disables the cap. Default: 2 hours — matches the legacy
     * `taskIdleTimeoutMs`.
     */
    mergeMaxGapMs: NumberInRange(2 * 60 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
  }, { default: {} }),
  retrieval: Type.Object({
    /** How many Skill snippets to inject at turn start. */
    tier1TopK: NumberInRange(3, 0, 100),
    /** How many trace/episode snippets to inject. */
    tier2TopK: NumberInRange(5, 0, 100),
    /** How many world-model snippets to inject. */
    tier3TopK: NumberInRange(2, 0, 100),
    /** Fetch K·factor candidates from SQLite before MMR/priority re-rank. */
    candidatePoolFactor: NumberInRange(4, 1, 50),
    /** Tier 2 fusion weight for cosine similarity (vs. priority). */
    weightCosine: NumberInRange(0.6, 0, 1),
    /** Tier 2 fusion weight for max(V,0)·decay(Δt) priority. */
    weightPriority: NumberInRange(0.4, 0, 1),
    /** MMR λ — 1 = pure relevance, 0 = pure diversity. */
    mmrLambda: NumberInRange(0.7, 0, 1),
    /** Hide V<0 traces by default (Decision Repair can override). */
    includeLowValue: Bool(false),
    /** Classic Reciprocal Rank Fusion constant. */
    rrfConstant: NumberInRange(60, 1, 10_000),
    /** Skip Tier-1 skills whose η is below this floor. */
    minSkillEta: NumberInRange(0.5, 0, 1),
    /** Drop Tier-2 hits whose cosine is below this floor. */
    minTraceSim: NumberInRange(0.35, 0, 1),
    /**
     * V7 §2.6 Tier 2b — minimum goal-level cosine for "episode replay"
     * to fire. Below this, we don't rollup episodes into a reference
     * action sequence (individual trace hits still go through).
     */
    episodeGoalMinSim: NumberInRange(0.45, 0, 1),
    /** auto | off | strict — controls tag-based pre-filtering. */
    tagFilter: Type.Union([
      Type.Literal("auto"),
      Type.Literal("off"),
      Type.Literal("strict"),
    ], { default: "auto" }),
    /**
     * Per-tier keyword (FTS5 + pattern) channel size. Each tier issues
     * a vector channel + an FTS channel + a pattern channel; this is
     * the K for the keyword channels (vector still uses
     * `tier{1,2,3}TopK · candidatePoolFactor`).
     */
    keywordTopK: NumberInRange(20, 0, 200),
    /**
     * Drop ranked candidates whose blended `relevance` is below
     * `topRelevance * relativeThresholdFloor`. Adaptive cousin of
     * `minTraceSim` — when the best hit is weak, we keep more (lower
     * absolute floor); when there's a clear winner, we drop noise.
     * Set to 0 to disable the relative cutoff entirely.
     *
     * Default lowered to 0.2 with the 2026 ranker overhaul: the new
     * base formula already weighs channel-rank evidence (so a raw
     * FTS-only hit lands in a comparable range to a cosine-0.8 hit),
     * and the old 0.4 floor was over-pruning keyword matches with
     * modest V·decay.
     */
    relativeThresholdFloor: NumberInRange(0.2, 0, 1),
    /**
     * Tier-1 skill relevance blend weight for `η` (skill reliability).
     * Old default `0.4` made well-trodden skills outrank obviously-more-
     * relevant new ones. `0.15` keeps the η nudge but lets the query↔skill
     * cosine dominate.
     */
    skillEtaBlend: NumberInRange(0.15, 0, 1),
    /**
     * MMR Phase-A seed-by-tier policy. When `true`, only seed a tier
     * if its best candidate's relevance ≥ `poolTopRelevance *
     * smartSeedRatio` (see below). This prevents the ranker from
     * force-injecting a stale Tier-1 skill / Tier-3 world-model just
     * because it cleared the absolute floors.
     */
    smartSeed: Bool(true),
    /**
     * Seed cutoff for smart-seed MMR — tier is seeded iff its best
     * candidate's relevance ≥ `poolTopRelevance * smartSeedRatio`.
     * Independent of `relativeThresholdFloor` so the seed gate can be
     * stricter than the generic drop floor (0.7 is "within 30% of the
     * best available candidate anywhere in the pool").
     */
    smartSeedRatio: NumberInRange(0.7, 0, 1),
    /**
     * When a candidate is surfaced by ≥ 2 retrieval channels (e.g.
     * both vec and fts hit the same trace), bypass the relative
     * threshold. Multi-channel agreement is a strong signal, and
     * without this keyword-only matches with modest V·decay often
     * get dropped by a noisy `topRelevance`.
     */
    multiChannelBypass: Bool(true),
    /**
     * How Tier-1 skills are surfaced in the injected prompt:
     *   - "summary" (default): inject only `name + η + 1-line summary +
     *     a `skill_get(id="…")` hint`. The agent decides whether to
     *     fetch the full procedure via the `skill_get` tool. Keeps the
     *     prompt small and avoids paying for skills the agent never
     *     uses.
     *   - "full": inline the entire `invocationGuide` body (legacy
     *     behaviour — useful for hosts that don't support tool calls).
     */
    skillInjectionMode: Type.Union(
      [Type.Literal("summary"), Type.Literal("full")],
      { default: "summary" },
    ),
    /**
     * Char cap for the per-skill summary body when `skillInjectionMode`
     * is `summary`. We trim the first paragraph of `invocationGuide`
     * and clamp to this many chars before appending the call-hint.
     */
    skillSummaryChars: NumberInRange(200, 40, 800),
    /**
     * LLM-based relevance filter (`core/retrieval/llm-filter.ts`).
     * Default on because cosine retrieval over-matches and a single
     * small LLM call dramatically cuts down irrelevant injections.
     */
    llmFilterEnabled: Bool(true),
    /** Keep at most this many candidates after the LLM filter. */
    llmFilterMaxKeep: NumberInRange(5, 1, 30),
    /**
     * Skip the filter when the ranked list has fewer than this many
     * items. Default 1 — even a single candidate gets a precision
     * pass, matching `memos-local-openclaw`'s tool-level filter and
     * preventing a lone off-topic memory from sneaking through
     * unchecked.
     */
    llmFilterMinCandidates: NumberInRange(1, 1, 50),
    /**
     * Body-text budget per candidate when building the LLM filter
     * prompt. Higher = more context for precise judgement, at the
     * cost of more tokens per round-trip. Default 500 (openclaw uses
     * 300 without tags/channels; we include richer metadata, so a
     * slightly larger window pays for itself).
     */
    llmFilterCandidateBodyChars: NumberInRange(500, 120, 2000),
  }, { default: {} }),
}, { default: {} });

const HubSchema = Type.Object({
  enabled: Bool(false),
  role: Type.Union([Type.Literal("hub"), Type.Literal("client")], { default: "client" }),
  port: NumberInRange(18912, 1, 65535),
  address: StringWithDefault(""),
  teamName: StringWithDefault(""),
  teamToken: StringWithDefault(""),
  userToken: StringWithDefault(""),
  nickname: StringWithDefault(""),
}, { default: {} });

const TelemetrySchema = Type.Object({
  enabled: Bool(true),
}, { default: {} });

const LoggingSchema = Type.Object({
  level: Type.Union([
    Type.Literal("trace"),
    Type.Literal("debug"),
    Type.Literal("info"),
    Type.Literal("warn"),
    Type.Literal("error"),
    Type.Literal("fatal"),
  ], { default: "info" }),
  console: Type.Object({
    enabled: Bool(true),
    pretty: Bool(true),
    channels: Type.Array(Type.String(), { default: ["*"] }),
  }, { default: {} }),
  file: Type.Object({
    enabled: Bool(true),
    format: Type.Union([Type.Literal("json"), Type.Literal("compact")], { default: "json" }),
    rotate: Type.Object({
      maxSizeMb: NumberInRange(50, 1),
      maxFiles: NumberInRange(14, 1),
      gzip: Bool(true),
    }, { default: {} }),
    /** Days to keep regular app/error/perf/llm/events files. */
    retentionDays: NumberInRange(30, 1),
  }, { default: {} }),
  audit: Type.Object({
    enabled: Bool(true),
    /** Audit retention is "forever": rotate by month, gzip; never delete. */
    rotate: Type.Object({
      monthly: Bool(true),
      gzip: Bool(true),
    }, { default: {} }),
  }, { default: {} }),
  llmLog: Type.Object({
    enabled: Bool(true),
    redactPrompts: Bool(false),
    redactCompletions: Bool(false),
  }, { default: {} }),
  perfLog: Type.Object({
    enabled: Bool(true),
    sampleRate: NumberInRange(1.0, 0, 1),
  }, { default: {} }),
  eventsLog: Type.Object({
    enabled: Bool(true),
  }, { default: {} }),
  redact: Type.Object({
    extraKeys: Type.Array(Type.String(), { default: ["api_key", "secret", "token", "password", "authorization"] }),
    extraPatterns: Type.Array(Type.String(), { default: [] }),
  }, { default: {} }),
  /** Per-channel level overrides, e.g. `{ "core.l2.cross-task": "debug" }`. */
  channels: Type.Record(Type.String(), Type.String(), { default: {} }),
}, { default: {} });

// ─── Top-level schema ───────────────────────────────────────────────────────

export const ConfigSchema = Type.Object({
  version: NumberInRange(1, 1),
  viewer: ViewerSchema,
  bridge: BridgeSchema,
  embedding: EmbeddingSchema,
  llm: LlmSchema,
  skillEvolver: SkillEvolverSchema,
  algorithm: AlgorithmSchema,
  hub: HubSchema,
  telemetry: TelemetrySchema,
  logging: LoggingSchema,
}, { default: {} });

export type ResolvedConfig = Static<typeof ConfigSchema>;
