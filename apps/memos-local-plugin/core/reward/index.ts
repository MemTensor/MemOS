/** Public entry for `core/reward`. */

export { createRewardRunner, type RewardDeps, type RewardRunner } from "./reward.js";
export {
  attachRewardSubscriber,
  type RewardSubscription,
  type RewardSubscriberOptions,
} from "./subscriber.js";
export { createRewardEventBus } from "./events.js";
export { backprop, priorityFor } from "./backprop.js";
export { scoreHuman, heuristicScore } from "./human-scorer.js";
export { buildTaskSummary } from "./task-summary.js";
export type {
  BackpropInput,
  BackpropResult,
  BackpropUpdate,
  HumanScore,
  HumanScoreInput,
  RewardConfig,
  RewardEvent,
  RewardEventBus,
  RewardEventKind,
  RewardEventListener,
  RewardInput,
  RewardResult,
  TaskSummary,
  UserFeedback,
} from "./types.js";
