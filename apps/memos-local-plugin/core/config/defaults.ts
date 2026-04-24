/**
 * The default config tree. Mirrors `schema.ts` exactly. When merging YAML,
 * we deep-merge over this tree so users only need to specify what they want
 * to change.
 */

import type { ResolvedConfig } from "./schema.js";

export const DEFAULT_CONFIG: ResolvedConfig = {
  version: 1,
  viewer: {
    // Per-agent default lives in `templates/config.<agent>.yaml`:
    //   - openclaw → 18799
    //   - hermes   → 18800
    // The fallback here only matters when neither config file exists
    // (early bootstrap, tests, etc.).
    port: 18799,
    bindHost: "127.0.0.1",
    openOnFirstTurn: false,
  },
  bridge: {
    port: 18911,
    mode: "stdio",
  },
  embedding: {
    provider: "local",
    endpoint: "",
    model: "Xenova/all-MiniLM-L6-v2",
    dimensions: 384,
    apiKey: "",
    cache: {
      enabled: true,
      maxItems: 20_000,
    },
  },
  llm: {
    provider: "local_only",
    endpoint: "",
    model: "",
    temperature: 0,
    fallbackToHost: true,
    apiKey: "",
    timeoutMs: 45_000,
    maxRetries: 3,
  },
  skillEvolver: {
    // Empty by default — falls back to the shared `llm` settings.
    // Operators set this when they want a stronger model (e.g.
    // claude-sonnet / gpt-5-thinking) for skill crystallisation.
    provider: "",
    endpoint: "",
    model: "",
    apiKey: "",
    temperature: 0,
    timeoutMs: 60_000,
  },
  algorithm: {
    capture: {
      maxTextChars: 4_000,
      maxToolOutputChars: 2_000,
      embedTraces: true,
      alphaScoring: true,
      // OpenClaw's tool messages don't include explicit "reflection"
      // blocks; without synthesis the alpha scorer sees an empty
      // reflection and forces α = 0 (see `core/capture/alpha-scorer.ts`
      // line 97). That makes reflection-weighted backprop degenerate
      // into pure γ-discount and produces flat V distributions —
      // L2 association + skill crystallization both starve. Enable
      // synth by default so even turns without explicit reflections
      // still contribute useful α values.
      synthReflections: true,
      llmConcurrency: 4,
      // V7 §3.2 batched variant. With "auto" we issue a single LLM call
      // per episode for both reflection synth and α scoring as long as
      // the episode is short enough — this collapses 2N per-step calls
      // (N synth + N α) into 1 batched call. Long episodes (>12 steps)
      // automatically fall back to the per-step path so the prompt
      // never overflows the model's context window. R_human + backprop
      // remain task-end events handled by `core/reward`, unchanged.
      batchMode: "auto",
      batchThreshold: 12,
    },
    reward: {
      gamma: 0.9,
      tauSoftmax: 0.5,
      decayHalfLifeDays: 30,
      llmScoring: true,
      implicitThreshold: 0.2,
      // 10 minutes was too long for interactive chat — users moved on
      // to the next task before reward ever fired, so no R_human was
      // ever computed and V stayed 0 for every trace. 30 s gives the
      // user a short window to reply ("thanks", "no, try again") that
      // the scorer picks up as explicit feedback; when nothing
      // arrives, the implicit fallback fires promptly so downstream
      // L2/L3/Skill stages aren't starved of signal.
      feedbackWindowSec: 30,
      summaryMaxChars: 2_000,
      llmConcurrency: 2,
      minExchangesForCompletion: 2,
      minContentCharsForCompletion: 80,
    },
    l2Induction: {
      minSimilarity: 0.65,
      candidateTtlDays: 30,
      minEpisodesForInduction: 2,
      // Lowered from 0.05 → 0.01. Reward backprop V values for typical
      // multi-step turns (5-15 steps) are clustered around 0.02-0.5 even
      // for successful episodes; the old 0.05 floor was throwing away
      // most of the signal before induction could see it. Negative-V
      // traces are still excluded (they'd never count as "with-set"
      // evidence anyway).
      minTraceValue: 0.01,
      useLlm: true,
      traceCharCap: 3_000,
      archiveGain: -0.05,
    },
    l3Abstraction: {
      // Lowered from 3 → 2. The original threshold required THREE
      // distinct active policies in the same domain cluster before any
      // world model could form, which in real usage takes weeks to
      // accumulate even for a focused user. Two compatible active
      // policies is the smallest meaningful cluster.
      minPolicies: 2,
      // Lowered from 0.1 → 0.02. With the Bayesian-shrinkage gain
      // formula (see core/memory/l2/gain.ts), a genuinely useful policy
      // that fires on a single-success path now scores around 0.05-0.20
      // (proportional to V_with - 0.5). 0.02 is well below that floor
      // but still cleanly rejects net-neutral noise.
      minPolicyGain: 0.02,
      minPolicySupport: 1,
      clusterMinSimilarity: 0.6,
      policyCharCap: 800,
      traceCharCap: 500,
      traceEvidencePerPolicy: 1,
      useLlm: true,
      cooldownDays: 1,
      confidenceDelta: 0.05,
      minConfidenceForRetrieval: 0.2,
    },
    skill: {
      minSupport: 2,
      // Lowered from 0.1 → 0.02. Same rationale as l3.minPolicyGain:
      // the new shrinkage-anchored gain formula gives positive scores
      // proportional to V_with − 0.5, so 0.1 was unreachable for any
      // policy that didn't have an explicit failure-cohort contrast.
      // 0.02 is enough to filter neutral-noise policies while still
      // letting genuinely-useful patterns crystallize.
      minGain: 0.02,
      // Lowered from 5 → 3. Demanding 5 trials in `candidate` before a
      // skill can graduate effectively meant most skills never made it
      // out of probation in real usage; 3 is the smallest number that
      // still gives the lifecycle a meaningful trial window.
      candidateTrials: 3,
      cooldownMs: 6 * 60 * 60 * 1000,
      traceCharCap: 500,
      evidenceLimit: 6,
      useLlm: true,
      etaDelta: 0.1,
      archiveEta: 0.25,
      minEtaForRetrieval: 0.5,
    },
    feedback: {
      failureThreshold: 3,
      failureWindow: 5,
      valueDelta: 0.5,
      useLlm: true,
      attachToPolicy: true,
      cooldownMs: 60_000,
      traceCharCap: 500,
      evidenceLimit: 4,
    },
    session: {
      followUpMode: "merge_follow_ups",
      mergeMaxGapMs: 2 * 60 * 60 * 1000,
    },
    retrieval: {
      tier1TopK: 3,
      tier2TopK: 5,
      tier3TopK: 2,
      candidatePoolFactor: 4,
      weightCosine: 0.6,
      weightPriority: 0.4,
      mmrLambda: 0.7,
      includeLowValue: false,
      rrfConstant: 60,
      minSkillEta: 0.5,
      minTraceSim: 0.35,
      episodeGoalMinSim: 0.45,
      tagFilter: "auto",
      keywordTopK: 20,
      // Lowered from 0.4 → 0.2 with the 2026 ranker overhaul: the new
      // base relevance already uses channel rank as a first-class
      // signal, so the old 0.4 floor was over-pruning keyword hits
      // with modest V·decay.
      relativeThresholdFloor: 0.2,
      skillEtaBlend: 0.15,
      smartSeed: true,
      smartSeedRatio: 0.7,
      multiChannelBypass: true,
      skillInjectionMode: "summary",
      skillSummaryChars: 200,
      llmFilterEnabled: true,
      // Tighter than the legacy default (5) so the LLM filter has a
      // small budget; combined with the richer prompt (v3) this keeps
      // packets concise without over-dropping.
      llmFilterMaxKeep: 4,
      // Lowered from 2 → 1: even a single candidate gets a precision
      // pass. Mirrors `memos-local-openclaw`'s tool-level filter and
      // prevents a lone off-topic memory from sneaking through unchecked.
      llmFilterMinCandidates: 1,
      llmFilterCandidateBodyChars: 500,
    },
  },
  hub: {
    enabled: false,
    role: "client",
    port: 18912,
    address: "",
    teamName: "",
    teamToken: "",
    userToken: "",
    nickname: "",
  },
  telemetry: { enabled: true },
  logging: {
    level: "info",
    console: { enabled: true, pretty: true, channels: ["*"] },
    file: {
      enabled: true,
      format: "json",
      rotate: { maxSizeMb: 50, maxFiles: 14, gzip: true },
      retentionDays: 30,
    },
    audit: {
      enabled: true,
      rotate: { monthly: true, gzip: true },
    },
    llmLog: { enabled: true, redactPrompts: false, redactCompletions: false },
    perfLog: { enabled: true, sampleRate: 1.0 },
    eventsLog: { enabled: true },
    redact: {
      extraKeys: ["api_key", "secret", "token", "password", "authorization"],
      extraPatterns: [],
    },
    channels: {},
  },
};

/**
 * Set of dotted-path field names whose values must never be sent to the
 * viewer or any non-localhost surface. Used by `server/routes/config.ts`.
 */
export const SECRET_FIELD_PATHS: readonly string[] = Object.freeze([
  "embedding.apiKey",
  "llm.apiKey",
  "skillEvolver.apiKey",
  "hub.teamToken",
  "hub.userToken",
]);
