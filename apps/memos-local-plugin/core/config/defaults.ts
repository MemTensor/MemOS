/**
 * The default config tree. Mirrors `schema.ts` exactly. When merging YAML,
 * we deep-merge over this tree so users only need to specify what they want
 * to change.
 */

import type { ResolvedConfig } from "./schema.js";

export const DEFAULT_CONFIG: ResolvedConfig = {
  version: 1,
  viewer: {
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
      minTraceValue: 0.05,
      useLlm: true,
      traceCharCap: 3_000,
      archiveGain: -0.05,
    },
    l3Abstraction: {
      minPolicies: 3,
      minPolicyGain: 0.1,
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
      minGain: 0.1,
      candidateTrials: 5,
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
      relativeThresholdFloor: 0.4,
      skillEtaBlend: 0.15,
      smartSeed: true,
      skillInjectionMode: "summary",
      skillSummaryChars: 200,
      llmFilterEnabled: true,
      // Tighter than the legacy default (5) so the LLM filter has a
      // budget that forces "drop, don't pad". Combined with the
      // few-shot prompt this dramatically improves precision.
      llmFilterMaxKeep: 4,
      // Lowered from 3 → 2: small packets (e.g. just a Tier-1 skill +
      // a Tier-2 trace) used to skip the LLM filter entirely and ship
      // both items even when one was tangential. Now anything > 1
      // candidate gets a precision pass.
      llmFilterMinCandidates: 2,
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
