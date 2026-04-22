/**
 * Public entry for `core/session`.
 */

export {
  createSessionManager,
  type SessionManager,
  type SessionManagerDeps,
  type StartEpisodeInput,
} from "./manager.js";
export {
  createEpisodeManager,
  type EpisodeManager,
  type EpisodeManagerDeps,
} from "./episode-manager.js";
export {
  createIntentClassifier,
  listHeuristicRules,
  type IntentClassifier,
  type IntentClassifierOptions,
} from "./intent-classifier.js";
export {
  createRelationClassifier,
  listRelationRules,
  type RelationClassifier,
  type RelationClassifierOptions,
} from "./relation-classifier.js";
export {
  HEURISTIC_RULES,
  matchFirst,
  retrievalFor,
  type HeuristicRule,
  type HeuristicMatch,
} from "./heuristics.js";
export { createSessionEventBus } from "./events.js";
export {
  adaptEpisodesRepo,
  adaptSessionsRepo,
  type EpisodesRepo,
  type SessionRepo,
} from "./persistence.js";
export type {
  EpisodeCloseReason,
  EpisodeFinalizeInput,
  EpisodeSnapshot,
  EpisodeStartInput,
  EpisodeTurn,
  IntentDecision,
  IntentKind,
  RelationDecision,
  RelationInput,
  SessionEvent,
  SessionEventBus,
  SessionEventKind,
  SessionEventListener,
  SessionOpenInput,
  SessionSnapshot,
  TurnRelation,
  TurnRole,
} from "./types.js";
