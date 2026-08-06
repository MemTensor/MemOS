/**
 * Re-exports of the agent-contract DTOs for viewer consumers.
 *
 * Kept deliberately thin so the viewer stays aligned with any schema
 * changes in the core. If the contract shifts, this is the single
 * import point to touch.
 */

export type {
  AgentKind,
  ApiLogDTO,
  EpisodeDTO,
  TraceDTO,
  PolicyDTO,
  WorldModelDTO,
  SkillDTO,
  FeedbackDTO,
  RetrievalQueryDTO,
  RetrievalResultDTO,
  RetrievalHitDTO,
  ToolOutcomeDTO,
  TurnInputDTO,
  TurnResultDTO,
} from "../../../agent-contract/dto";

export type {
  CoreEvent,
  CoreEventType,
} from "../../../agent-contract/events";

export type {
  LogRecord,
  LogLevel,
} from "../../../agent-contract/log-record";
