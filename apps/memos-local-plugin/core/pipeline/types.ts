/**
 * `core/pipeline` — public types.
 *
 * The pipeline is the only module the adapters touch. It owns the
 * dependency graph that wires L1 capture → reward → L2 → L3 → skill →
 * feedback → retrieval into a single cohesive object. Adapters receive a
 * `MemoryCore` facade (see `memory-core.ts`) that delegates to these
 * orchestrator entry points.
 *
 * Every field here crosses module boundaries, so we keep the shape JSON-
 * friendly (plain objects, ms epochs, no class instances).
 */

import type { Embedder } from "../embedding/types.js";
import type { LlmClient } from "../llm/types.js";
import type { Logger } from "../logger/types.js";
import type { Repos } from "../storage/repos/index.js";
import type { StorageDb } from "../storage/index.js";
import type { ResolvedConfig, ResolvedHome } from "../config/index.js";

import type { CaptureConfig, CaptureEventBus } from "../capture/types.js";
import type { CaptureRunner } from "../capture/capture.js";
import type { CaptureSubscription } from "../capture/subscriber.js";
import type { RewardConfig, RewardEventBus } from "../reward/types.js";
import type { RewardRunner } from "../reward/reward.js";
import type { RewardSubscription } from "../reward/subscriber.js";
import type { L2Config, L2EventBus } from "../memory/l2/types.js";
import type { L2SubscriberHandle } from "../memory/l2/subscriber.js";
import type { L3Config, L3EventBus } from "../memory/l3/types.js";
import type { L3SubscriberHandle } from "../memory/l3/subscriber.js";
import type {
  SkillConfig,
  SkillEventBus,
} from "../skill/index.js";
import type { SkillSubscriberHandle } from "../skill/subscriber.js";
import type {
  FeedbackConfig,
  FeedbackEventBus,
} from "../feedback/types.js";
import type { FeedbackSubscriberHandle } from "../feedback/subscriber.js";
import type {
  RetrievalConfig,
  RetrievalDeps,
  RetrievalResult,
} from "../retrieval/types.js";
import type { RetrievalEventBus } from "../retrieval/events.js";
import type {
  EpisodeManager,
  EpisodeSnapshot,
  IntentClassifier,
  RelationClassifier,
  SessionEvent,
  SessionEventBus,
  SessionManager,
} from "../session/index.js";

import type {
  AgentKind,
  EpisodeId,
  InjectionPacket,
  RepairCtx,
  SessionId,
  ToolDrivenCtx,
  TurnInputDTO,
  TurnResultDTO,
  TurnStartCtx,
} from "../../agent-contract/dto.js";
import type {
  SkillInvokeCtx,
  SubAgentCtx,
} from "../retrieval/types.js";
import type { CoreEvent } from "../../agent-contract/events.js";
import type { LogRecord } from "../../agent-contract/log-record.js";

// ─── Pipeline configuration slice ─────────────────────────────────────────

/**
 * All algorithm-facing config the pipeline forwards into the individual
 * subscribers. Kept as a read-only slice of `ResolvedConfig.algorithm`
 * so the pipeline can be instantiated with a narrow contract and still
 * know its own defaults.
 */
export interface PipelineAlgorithmConfig {
  capture: CaptureConfig;
  reward: RewardConfig;
  l2Induction: L2Config;
  l3Abstraction: L3Config;
  skill: SkillConfig;
  feedback: FeedbackConfig;
  retrieval: RetrievalConfig;
  session: SessionRoutingConfig;
}

/**
 * How the pipeline routes a new user turn relative to the previously
 * closed episode. See `algorithm.session` in the config schema for the
 * semantic contract.
 */
export interface SessionRoutingConfig {
  /**
   * `"merge_follow_ups"` (default) — revisions and follow-ups append to
   * the previous episode. `"episode_per_turn"` keeps V7 §0.1 strict
   * semantics (each follow-up opens a new episode).
   */
  followUpMode: "merge_follow_ups" | "episode_per_turn";
  /**
   * Hard cap (ms) on merged-episode span. 0 disables. When the gap
   * since the previous episode's `endedAt` exceeds this, we force a
   * new-episode boundary even for revision/follow_up verdicts.
   */
  mergeMaxGapMs: number;
}

// ─── Dependency graph ─────────────────────────────────────────────────────

/**
 * The pipeline owns every long-lived service. The caller (usually an
 * adapter bootstrap or `createMemoryCore`) supplies the foundational
 * infrastructure; the pipeline wires the algorithm subscribers together.
 */
export interface PipelineDeps {
  agent: AgentKind;
  home: ResolvedHome;
  config: ResolvedConfig;
  db: StorageDb;
  repos: Repos;
  llm: LlmClient | null;
  /**
   * Dedicated LLM for the topic-end reflection + α scoring pass.
   * Built from `config.skillEvolver.*` when the user configures a
   * stronger model for skill evolution; falls back to `llm` when
   * absent. Summarization and per-turn lite capture still use `llm`.
   */
  reflectLlm: LlmClient | null;
  embedder: Embedder | null;
  log: Logger;
  /** Injection hook so tests can provide a fake clock. */
  now?: () => number;
}

/**
 * Internal handle returned by `createPipeline`. The `MemoryCore` facade
 * closes over this handle and exposes only the adapter-facing shape.
 */
export interface PipelineHandle {
  readonly agent: AgentKind;
  readonly home: ResolvedHome;
  readonly config: ResolvedConfig;
  readonly algorithm: PipelineAlgorithmConfig;

  // Infrastructure (adapters that want direct access).
  readonly db: StorageDb;
  readonly repos: Repos;
  readonly llm: LlmClient | null;
  /**
   * Dedicated client for skill-evolution reflection. When the operator
   * leaves `skillEvolver.*` blank, this is the same instance as `llm`
   * (so call sites can blindly read whichever is non-null). When they
   * configure their own model it carries its own `stats()` so the
   * Overview / health endpoint reports the *actual* skill-evolver
   * status instead of falling back to the summary LLM.
   */
  readonly reflectLlm: LlmClient | null;
  readonly embedder: Embedder | null;

  // Subscribers / runners.
  readonly sessionManager: SessionManager;
  readonly episodeManager: EpisodeManager;
  readonly intent: IntentClassifier;
  readonly relation: RelationClassifier;
  readonly captureRunner: CaptureRunner;
  readonly rewardRunner: RewardRunner;
  readonly l2: L2SubscriberHandle;
  readonly l3: L3SubscriberHandle;
  readonly skills: SkillSubscriberHandle;
  readonly feedback: FeedbackSubscriberHandle;

  // Event buses (pipeline owns + aggregates into a unified CoreEvent stream).
  readonly buses: PipelineBuses;

  // Observability.
  subscribeEvents(handler: (event: CoreEvent) => void): () => void;
  /**
   * Snapshot of the most-recent aggregated core events kept in a small
   * ring buffer. Late-connecting SSE clients replay this so the live
   * activity panel in the viewer is never empty on reload.
   */
  getRecentEvents(): readonly CoreEvent[];
  subscribeLogs(handler: (record: LogRecord) => void): () => void;

  // Orchestrator entry points (turn lifecycle).
  onTurnStart(input: TurnInputDTO): Promise<InjectionPacket>;
  onTurnEnd(result: TurnResultDTO): Promise<TurnEndResult>;

  // Tool-level signals.
  recordToolOutcome(outcome: RecordToolOutcomeInput): void;

  // Custom retrieval entry points (non-turn-start).
  retrieveToolDriven(ctx: ToolDrivenCtx): Promise<InjectionPacket>;
  retrieveSkillInvoke(ctx: SkillInvokeCtx): Promise<InjectionPacket>;
  retrieveSubAgent(ctx: SubAgentCtx): Promise<InjectionPacket>;
  retrieveRepair(ctx: RepairCtx): Promise<InjectionPacket | null>;

  // Imperative helpers.
  flush(): Promise<void>;
  shutdown(reason?: string): Promise<void>;

  /** Compose a retrieval-deps instance scoped to this pipeline. Used by tests. */
  retrievalDeps(): RetrievalDeps;
}

export interface PipelineBuses {
  session: SessionEventBus;
  capture: CaptureEventBus;
  reward: RewardEventBus;
  l2: L2EventBus;
  l3: L3EventBus;
  skill: SkillEventBus;
  feedback: FeedbackEventBus;
  retrieval: RetrievalEventBus;
}

// ─── Subscriptions + lifecycle ────────────────────────────────────────────

export interface PipelineSubscriptions {
  capture: CaptureSubscription;
  reward: RewardSubscription;
}

// ─── Orchestrator I/O shapes ──────────────────────────────────────────────

export interface RecordToolOutcomeInput {
  sessionId: SessionId;
  episodeId?: EpisodeId;
  tool: string;
  /** Adapter-normalized step index (monotonic within the episode). */
  step: number;
  success: boolean;
  errorCode?: string;
  /** Short group tag — session id or domain-scoped string. */
  context?: string;
  /** Optional epoch ms. Defaults to `Date.now()`. */
  ts?: number;
}

export interface TurnEndResult {
  traceCount: number;
  /** Trace ids actually persisted by the per-turn lite capture pass. */
  traceIds: string[];
  /** The episode we wrote this turn into. */
  episodeId: EpisodeId;
  /**
   * Snapshot of the episode after `addTurn`. May be `null` in rare
   * race conditions where the manager evicted the episode between
   * `addTurn` and the snapshot read — callers must guard against it.
   */
  episode: EpisodeSnapshot | null;
  /** True when the session manager chose to close this episode this turn. */
  episodeFinalized: boolean;
  /** When `true`, downstream capture + reward + L2 are already in-flight. */
  asyncWorkScheduled: boolean;
}

// ─── Session / turn bridge ────────────────────────────────────────────────

export interface PipelineSessionHooks {
  /**
   * Called by the pipeline whenever the session bus emits. Adapters can
   * use it to surface session/episode transitions in their UI or logs
   * without subscribing twice.
   */
  onSessionEvent?: (evt: SessionEvent) => void;
}

// ─── Convenience retrieval helpers ────────────────────────────────────────

/**
 * Minimal ctx the pipeline derives from a `TurnInputDTO`. Exposed for
 * tests that want to assert the retrieval ctx the pipeline passes down.
 */
export interface DerivedTurnStartCtx extends TurnStartCtx {
  /** Stable sessionId the pipeline resolved (may have been auto-opened). */
  sessionId: SessionId;
  /** The episode the pipeline resolved (or `undefined` pre-open). */
  episodeId?: EpisodeId;
}

/**
 * The rolled-up retrieval outcome used both by adapters and by the
 * viewer. The pipeline always returns an `InjectionPacket` — tests that
 * want richer stats should use `pipeline.retrievalDeps()` directly.
 */
export interface PipelineRetrievalResult extends RetrievalResult {
  /** For logging: why the retrieval ran. */
  reason: "turn_start" | "tool_driven" | "skill_invoke" | "sub_agent" | "decision_repair";
}
