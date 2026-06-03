import type { SessionId, EpisodeId } from "../../agent-contract/dto.js";
import type { IntentDecision, TurnRelation } from "../session/types.js";

export type InjectionScenarioId =
  | "CHITCHAT"
  | "META"
  | "MEMORY_PROBE"
  | "NEW_TASK"
  | "FOLLOW_UP"
  | "TASK"
  | "UNKNOWN_SAFE";

export interface SchedulerContext {
  userText: string;
  sessionId: SessionId;
  episodeId: EpisodeId;
  intent: IntentDecision;
  relation?: TurnRelation | "bootstrap" | "lightweight_memory";
}

export interface RetrievePlan {
  scenarioId: InjectionScenarioId;
  entry: "turn_start" | "turn_start_skip";
  wantTier1: boolean;
  wantTier2: boolean;
  wantTier3: boolean;
  prepend: boolean;
}

export function scheduleInjection(ctx: SchedulerContext): RetrievePlan {
  const { intent, relation } = ctx;

  if (intent.kind === "chitchat" && intent.confidence >= 0.6) {
    return skipPlan("CHITCHAT");
  }

  if (intent.kind === "chitchat") {
    return retrievePlan("UNKNOWN_SAFE", { tier1: true, tier2: true, tier3: true });
  }

  if (intent.kind === "meta") {
    return skipPlan("META");
  }

  if (intent.kind === "memory_probe") {
    return retrievePlan("MEMORY_PROBE", intent.retrieval);
  }

  if (relation === "new_task") {
    return retrievePlan("NEW_TASK", intent.retrieval);
  }

  if (relation === "revision" || relation === "follow_up" || relation === "unknown") {
    return retrievePlan("FOLLOW_UP", intent.retrieval);
  }

  if (intent.kind === "unknown") {
    return retrievePlan("UNKNOWN_SAFE", { tier1: true, tier2: true, tier3: true });
  }

  return retrievePlan("TASK", intent.retrieval);
}

function skipPlan(scenarioId: Extract<InjectionScenarioId, "CHITCHAT" | "META">): RetrievePlan {
  return {
    scenarioId,
    entry: "turn_start_skip",
    wantTier1: false,
    wantTier2: false,
    wantTier3: false,
    prepend: false,
  };
}

function retrievePlan(
  scenarioId: Exclude<InjectionScenarioId, "CHITCHAT" | "META">,
  retrieval: IntentDecision["retrieval"],
): RetrievePlan {
  return {
    scenarioId,
    entry: "turn_start",
    wantTier1: retrieval.tier1,
    wantTier2: retrieval.tier2,
    wantTier3: retrieval.tier3,
    prepend: true,
  };
}
