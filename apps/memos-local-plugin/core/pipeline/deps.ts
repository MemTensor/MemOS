/**
 * Dependency-graph wiring for `core/pipeline`.
 *
 * The pipeline owns the long-lived objects every algorithm subscriber
 * needs (runners, buses, subscribers). Wiring is deterministic and
 * synchronous so adapters can reason about lifecycle without chasing
 * microtasks — with one exception: `init()` is async because it warms
 * the embedder/LLM bridges.
 */

import { rootLogger } from "../logger/index.js";
import type { Logger } from "../logger/types.js";
import type { StorageDb } from "../storage/index.js";

import {
  createSessionManager,
  createEpisodeManager,
  createSessionEventBus,
  createIntentClassifier,
  createRelationClassifier,
  adaptSessionsRepo,
  adaptEpisodesRepo,
} from "../session/index.js";
import type {
  EpisodeManager,
  IntentClassifier,
  RelationClassifier,
  SessionEventBus,
  SessionManager,
} from "../session/index.js";

import {
  createCaptureEventBus,
  createCaptureRunner,
  attachCaptureSubscriber,
} from "../capture/index.js";
import type {
  CaptureEventBus,
  CaptureRunner,
  CaptureSubscription,
} from "../capture/index.js";

import {
  createRewardEventBus,
  createRewardRunner,
  attachRewardSubscriber,
} from "../reward/index.js";
import type {
  RewardEventBus,
  RewardRunner,
  RewardSubscription,
} from "../reward/index.js";

import {
  attachL2Subscriber,
  createL2EventBus,
} from "../memory/l2/index.js";
import type {
  L2EventBus,
  L2SubscriberHandle,
} from "../memory/l2/index.js";

import {
  attachL3Subscriber,
  createL3EventBus,
} from "../memory/l3/index.js";
import type {
  L3EventBus,
  L3SubscriberHandle,
} from "../memory/l3/index.js";

import {
  attachSkillSubscriber,
  createSkillEventBus,
} from "../skill/index.js";
import type { SkillEventBus, SkillSubscriberHandle } from "../skill/index.js";

import {
  attachFeedbackSubscriber,
  createFeedbackEventBus,
} from "../feedback/index.js";
import type {
  FeedbackEventBus,
  FeedbackSubscriberHandle,
} from "../feedback/index.js";

import {
  createRetrievalEventBus,
} from "../retrieval/index.js";
import type {
  RetrievalDeps,
  RetrievalEventBus,
} from "../retrieval/index.js";

import type {
  PipelineAlgorithmConfig,
  PipelineBuses,
  PipelineDeps,
  PipelineSubscriptions,
} from "./types.js";
import { wrapRetrievalRepos } from "./retrieval-repos.js";

// ─── Algorithm config slice helper ────────────────────────────────────────

/**
 * Translate the validated `ResolvedConfig.algorithm` block (shaped by
 * the TypeBox schema) into the typed configs consumed by each subscriber.
 *
 * Some fields are shared across subscribers (γ / τ / decay half-life) and
 * live on the reward block in `config.yaml`. We copy them into the
 * downstream slices here so subscribers never peek into other blocks.
 */
export function extractAlgorithmConfig(
  deps: PipelineDeps,
): PipelineAlgorithmConfig {
  const alg = deps.config.algorithm;
  return {
    lightweightMemory: {
      enabled: alg.lightweightMemory.enabled,
    },
    capture: alg.capture,
    reward: alg.reward,
    l2Induction: {
      minSimilarity: alg.l2Induction.minSimilarity,
      candidateTtlDays: alg.l2Induction.candidateTtlDays,
      gamma: alg.reward.gamma,
      tauSoftmax: alg.reward.tauSoftmax,
      useLlm: alg.l2Induction.useLlm,
      minTraceValue: alg.l2Induction.minTraceValue,
      minEpisodesForInduction: alg.l2Induction.minEpisodesForInduction,
      inductionTraceCharCap: alg.l2Induction.traceCharCap,
      gainEmaAlpha: alg.l2Induction.gainEmaAlpha,
    },
    l3Abstraction: alg.l3Abstraction,
    skill: alg.skill,
    feedback: alg.feedback,
    retrieval: {
      tier1TopK: alg.retrieval.tier1TopK,
      tier2TopK: alg.retrieval.tier2TopK,
      tier3TopK: alg.retrieval.tier3TopK,
      candidatePoolFactor: alg.retrieval.candidatePoolFactor,
      weightCosine: alg.retrieval.weightCosine,
      weightPriority: alg.retrieval.weightPriority,
      mmrLambda: alg.retrieval.mmrLambda,
      includeLowValue: alg.retrieval.includeLowValue,
      rrfConstant: alg.retrieval.rrfConstant,
      minSkillEta: alg.retrieval.minSkillEta,
      minTraceSim: alg.retrieval.minTraceSim,
      tagFilter: alg.retrieval.tagFilter,
      keywordTopK: alg.retrieval.keywordTopK,
      ftsTokenizer: deps.config.storage.ftsTokenizer,
      relativeThresholdFloor: alg.retrieval.relativeThresholdFloor,
      skillEtaBlend: alg.retrieval.skillEtaBlend,
      smartSeed: alg.retrieval.smartSeed,
      smartSeedRatio: alg.retrieval.smartSeedRatio,
      multiChannelBypass: alg.retrieval.multiChannelBypass,
      skillInjectionMode: alg.retrieval.skillInjectionMode,
      skillSummaryChars: alg.retrieval.skillSummaryChars,
      decayHalfLifeDays: alg.reward.decayHalfLifeDays,
      llmFilterEnabled: alg.lightweightMemory.enabled ? true : alg.retrieval.llmFilterEnabled,
      llmFilterMaxKeep: alg.retrieval.llmFilterMaxKeep,
      llmFilterMinCandidates: alg.lightweightMemory.enabled ? 1 : alg.retrieval.llmFilterMinCandidates,
      llmFilterCandidateBodyChars: alg.retrieval.llmFilterCandidateBodyChars,
      lightweightMemory: alg.lightweightMemory.enabled,
      vectorScanMaxAgeMs: alg.retrieval.vectorScanMaxAgeMs,
    },
    session: {
      followUpMode: alg.session.followUpMode,
      mergeMaxGapMs: alg.session.mergeMaxGapMs,
    },
  };
}

// ─── Bus wiring ───────────────────────────────────────────────────────────

export function buildPipelineBuses(): PipelineBuses {
  return {
    session: createSessionEventBus(),
    capture: createCaptureEventBus(),
    reward: createRewardEventBus(),
    l2: createL2EventBus(),
    l3: createL3EventBus(),
    skill: createSkillEventBus(),
    feedback: createFeedbackEventBus(),
    retrieval: createRetrievalEventBus(),
  };
}

// ─── Subscriber graph ─────────────────────────────────────────────────────

export interface PipelineSubscriberSet {
  captureRunner: CaptureRunner;
  rewardRunner: RewardRunner;
  l2: L2SubscriberHandle;
  l3: L3SubscriberHandle;
  skills: SkillSubscriberHandle;
  feedback: FeedbackSubscriberHandle;
  subscriptions: PipelineSubscriptions;
}

export function buildPipelineSubscribers(
  deps: PipelineDeps,
  buses: PipelineBuses,
  algorithm: PipelineAlgorithmConfig,
  session?: PipelineSessionSet,
): PipelineSubscriberSet {
  const log = deps.log ?? rootLogger.child({ channel: "core.pipeline" });
  const lightweightMode = algorithm.lightweightMemory.enabled;

  const captureRunner = createCaptureRunner({
    tracesRepo: deps.repos.traces,
    embeddingRetryQueue: deps.repos.embeddingRetryQueue,
    episodesRepo: adaptEpisodesRepo(deps.repos.episodes),
    embedder: deps.embedder,
    llm: deps.llm,
    reflectLlm: deps.reflectLlm,
    bus: buses.capture,
    cfg: algorithm.capture,
    now: deps.now,
  });

  // Lightweight mode short-circuits the evolution pipeline: reward /
  // L2 / L3 / skill / feedback subscribers are NOT attached to their
  // upstream buses. This matches the schema comment on
  // `algorithm.lightweightMemory.enabled` which promises that only
  // summarize + embedding + retrieval filter remain active. Attaching
  // the subscribers used to be unconditional (issue #2063) — every
  // `episode.finalized` event still cascaded through the LLM-heavy
  // evolution chain, defeating the flag.
  if (lightweightMode) {
    log.info("pipeline.lightweight_mode.enabled", {
      skipped: ["reward", "l2", "l3", "skill", "feedback"],
    });
    return {
      captureRunner,
      rewardRunner: lightweightRewardRunnerStub(),
      l2: lightweightL2Handle(),
      l3: lightweightL3Handle(),
      skills: lightweightSkillHandle(),
      feedback: lightweightFeedbackHandle(),
      subscriptions: {
        capture: lightweightCaptureSubscription(),
        reward: lightweightRewardSubscription(),
      },
    };
  }

  const rewardRunner = createRewardRunner({
    tracesRepo: deps.repos.traces,
    episodesRepo: deps.repos.episodes,
    feedbackRepo: deps.repos.feedback,
    llm: deps.llm,
    bus: buses.reward,
    cfg: algorithm.reward,
    evaluator: {
      reflectionProvider: deps.reflectLlm?.provider,
      reflectionModel: deps.reflectLlm?.model,
      scorerProvider: deps.llm?.provider,
      scorerModel: deps.llm?.model,
    },
    now: deps.now,
    // Wire the live episode snapshot so the R_human scorer sees the
    // real user / assistant turns of the episode. Without this, the
    // reward runner falls back to `fallbackSnapshotFromRow` — a row
    // that has no `turns` — and every episode's task summary
    // degenerates to "(no user text)" / "(no agent text)". That
    // forces the scoring LLM to return `rHuman = 0`, which then
    // keeps every trace's V at exactly 0 and prevents L2 induction
    // (since `minTraceValue` is 0.1 by default), which in turn
    // starves L3 and the skill crystallizer. This is the single
    // biggest cause of "empty Experiences / World Models / Skills
    // pages after weeks of usage".
    getEpisodeSnapshot: session
      ? (id) => session.sessionManager.getEpisode(id)
      : undefined,
  });

  const captureSub = attachCaptureSubscriber(buses.session, captureRunner, {});
  const rewardSub = attachRewardSubscriber(
    buses.capture,
    rewardRunner,
    algorithm.reward,
    {},
  );

  const l2Handle = attachL2Subscriber({
    db: deps.db,
    repos: deps.repos,
    rewardBus: buses.reward,
    l2Bus: buses.l2,
    llm: deps.llm,
    log: log.child({ channel: "core.memory.l2" }),
    config: algorithm.l2Induction,
    thresholds: {
      minSupport: algorithm.skill.minSupport,
      minGain: algorithm.skill.minGain,
      archiveGain: deps.config.algorithm.l2Induction.archiveGain,
    },
  });

  const l3Handle = attachL3Subscriber({
    repos: deps.repos,
    l2Bus: buses.l2,
    l3Bus: buses.l3,
    // Dedicated L3 model when `config.l3Llm.*` is set; otherwise the
    // bootstrap aliases `l3Llm` to the main `llm`, so this is a no-op.
    llm: deps.l3Llm ?? deps.llm,
    log: log.child({ channel: "core.memory.l3" }),
    config: algorithm.l3Abstraction,
  });

  const skillHandle = attachSkillSubscriber({
    repos: deps.repos,
    embedder: deps.embedder,
    llm: deps.llm,
    bus: buses.skill,
    l2Bus: buses.l2,
    rewardBus: buses.reward,
    log: log.child({ channel: "core.skill" }),
    config: algorithm.skill,
  });

  const feedbackHandle = attachFeedbackSubscriber({
    repos: deps.repos,
    llm: deps.llm,
    embedder: deps.embedder,
    bus: buses.feedback,
    log: log.child({ channel: "core.feedback" }),
    config: algorithm.feedback,
  });

  return {
    captureRunner,
    rewardRunner,
    l2: l2Handle,
    l3: l3Handle,
    skills: skillHandle,
    feedback: feedbackHandle,
    subscriptions: {
      capture: captureSub,
      reward: rewardSub,
    },
  };
}

// ─── Session + intent + episode managers ──────────────────────────────────

export interface PipelineSessionSet {
  intent: IntentClassifier;
  relation: RelationClassifier;
  sessionManager: SessionManager;
  episodeManager: EpisodeManager;
}

export function buildPipelineSession(
  deps: PipelineDeps,
  bus: SessionEventBus,
): PipelineSessionSet {
  const llmDisabled = deps.config.algorithm.lightweightMemory.enabled;
  const intent = createIntentClassifier({
    llm: deps.llm ?? undefined,
    disableLlm: llmDisabled,
  });
  const relation = createRelationClassifier({
    llm: deps.llm ?? undefined,
    disableLlm: llmDisabled,
  });
  const episodeManager = createEpisodeManager({
    sessionsRepo: adaptSessionsRepo(deps.repos.sessions),
    episodesRepo: adaptEpisodesRepo(deps.repos.episodes),
    bus,
    now: deps.now,
  });
  const sessionManager = createSessionManager({
    sessionsRepo: adaptSessionsRepo(deps.repos.sessions),
    episodesRepo: adaptEpisodesRepo(deps.repos.episodes),
    intentClassifier: intent,
    bus,
    episodeManager,
    now: deps.now,
    lightweightMemory: llmDisabled,
  });
  return { intent, relation, sessionManager, episodeManager };
}

// ─── Retrieval deps ───────────────────────────────────────────────────────

export function buildRetrievalDeps(
  deps: PipelineDeps,
  algorithm: PipelineAlgorithmConfig,
): RetrievalDeps {
  const embedder = deps.embedder;
  return {
    repos: wrapRetrievalRepos(deps.repos, deps.namespace),
    embedder: embedder
      ? {
          embed: (text, role) =>
            embedder.embedOne({ text, role: role ?? "query" }),
        }
      : {
          // Degraded mode: empty vector so vector-scoring falls back to
          // zeros. Tier 2/3 still work via tags.
          embed: async () =>
            new Float32Array(0) as unknown as import("../types.js").EmbeddingVector,
        },
    config: algorithm.retrieval,
    namespace: deps.namespace,
    now: deps.now ?? Date.now,
    llm: deps.llm,
  };
}

// ─── Log helpers ──────────────────────────────────────────────────────────

export function pipelineLogger(deps: PipelineDeps): Logger {
  return deps.log ?? rootLogger.child({ channel: "core.pipeline" });
}

/** Called by tests that need to assert on the wiring. */
export { createRetrievalEventBus, createSessionEventBus };
export type {
  CaptureEventBus,
  CaptureRunner,
  CaptureSubscription,
  FeedbackEventBus,
  FeedbackSubscriberHandle,
  L2EventBus,
  L2SubscriberHandle,
  L3EventBus,
  L3SubscriberHandle,
  RetrievalEventBus,
  RewardEventBus,
  RewardRunner,
  RewardSubscription,
  SessionEventBus,
  SkillEventBus,
  SkillSubscriberHandle,
};

// ─── Lightweight-mode subscriber stubs ────────────────────────────────────
//
// When `algorithm.lightweightMemory.enabled` is `true`, the pipeline skips
// mounting the reward / L2 / L3 / skill / feedback runners entirely (see
// issue #2063). Downstream code (memory-core, orchestrator) still holds
// references to these handles for shape compatibility (`flush()` /
// `shutdown()` walk the whole subscriber set) but every caller that would
// actually invoke a runner is already gated behind the same lightweight
// check — so these stubs must only satisfy the type shape + drain/stop
// lifecycle without producing events or LLM traffic.

function throwLightweight(feature: string): never {
  throw new Error(
    `pipeline: ${feature} is unavailable while ` +
      `algorithm.lightweightMemory.enabled=true. Every caller must gate ` +
      `on the same flag before invoking it.`,
  );
}

function lightweightRewardRunnerStub(): RewardRunner {
  return {
    async run() {
      return throwLightweight("rewardRunner.run");
    },
  };
}

function lightweightRewardSubscription(): RewardSubscription {
  return {
    submitFeedback() {
      throwLightweight("rewardSubscription.submitFeedback");
    },
    async runManually() {
      return throwLightweight("rewardSubscription.runManually");
    },
    stop() {
      /* no-op — nothing was attached */
    },
    async drain() {
      /* no-op — no in-flight work in lightweight mode */
    },
    pendingCount() {
      return 0;
    },
  };
}

function lightweightCaptureSubscription(): CaptureSubscription {
  return {
    stop() {
      /* no-op — capture subscriber is not attached in lightweight mode */
    },
    async drain() {
      /* no-op — orchestrator calls runLightweight/runLite directly */
    },
    pendingCount() {
      return 0;
    },
  };
}

function lightweightL2Handle(): L2SubscriberHandle {
  return {
    detach() {
      /* no-op */
    },
    async runOnce() {
      return throwLightweight("l2.runOnce");
    },
    async drain() {
      /* no-op */
    },
  };
}

function lightweightL3Handle(): L3SubscriberHandle {
  return {
    detach() {
      /* no-op */
    },
    async drain() {
      /* no-op */
    },
    async runOnce() {
      return throwLightweight("l3.runOnce");
    },
    async adjustFeedback() {
      return throwLightweight("l3.adjustFeedback");
    },
  };
}

function lightweightSkillHandle(): SkillSubscriberHandle {
  return {
    dispose() {
      /* no-op */
    },
    async runOnce() {
      return throwLightweight("skills.runOnce");
    },
    applyFeedback() {
      throwLightweight("skills.applyFeedback");
    },
    async lifecycleTick() {
      /* no-op */
    },
    async flush() {
      /* no-op */
    },
  };
}

function lightweightFeedbackHandle(): FeedbackSubscriberHandle {
  const signals: FeedbackSubscriberHandle["signals"] = {
    recordFailure() {
      return null;
    },
    recordSuccess() {
      /* no-op */
    },
    peek() {
      return null;
    },
    clear() {
      /* no-op */
    },
    stats() {
      return { states: 0, totalFailures: 0 };
    },
  };
  return {
    recordToolFailure() {
      /* no-op — feedback subsystem is off in lightweight mode */
    },
    recordToolSuccess() {
      /* no-op */
    },
    async submitUserFeedback() {
      return throwLightweight("feedback.submitUserFeedback");
    },
    async runOnce() {
      return throwLightweight("feedback.runOnce");
    },
    signals,
    async flush() {
      /* no-op */
    },
    dispose() {
      /* no-op */
    },
  };
}
