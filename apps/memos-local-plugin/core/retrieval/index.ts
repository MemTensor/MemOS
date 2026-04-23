/**
 * Public surface of `core/retrieval`.
 *
 * Consumers (pipeline, server, adapters, tests) import from this file.
 * Everything else in the folder is an implementation detail.
 */

export {
  turnStartRetrieve,
  toolDrivenRetrieve,
  skillInvokeRetrieve,
  subAgentRetrieve,
  repairRetrieve,
  Retriever,
  type TurnStartRetrieveCtx,
  type ToolDrivenRetrieveCtx,
  type SkillInvokeRetrieveCtx,
  type SubAgentRetrieveCtx,
  type RepairRetrieveCtx,
  type RetrieveOptions,
} from "./retrieve.js";

export {
  createRetrievalEventBus,
  type RetrievalEvent,
  type RetrievalEventBus,
  type RetrievalEventKind,
  type RetrievalEventListener,
} from "./events.js";

export type {
  RetrievalCtx,
  RetrievalConfig,
  RetrievalDeps,
  RetrievalEmbedder,
  RetrievalRepos,
  RetrievalResult,
  RetrievalStats,
  SkillCandidate,
  TraceCandidate,
  EpisodeCandidate,
  WorldModelCandidate,
  TierCandidate,
  TierKind,
  TraceVecKind,
  RankedSnippet,
  SkillInvokeCtx,
  SubAgentCtx,
} from "./types.js";

export { buildQuery, extractTags } from "./query-builder.js";
