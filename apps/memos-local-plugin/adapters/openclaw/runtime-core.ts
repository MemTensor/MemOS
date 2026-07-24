import type { MemoryCore } from "../../agent-contract/memory-core.js";

/**
 * The exact core surface used by OpenClaw hooks and tools.
 *
 * Keeping this narrower than MemoryCore prevents a remote facade from
 * compiling while silently throwing for unrelated administration methods.
 */
export type OpenClawRuntimeCore = Pick<
  MemoryCore,
  | "health"
  | "openSession"
  | "closeSession"
  | "openEpisode"
  | "closeEpisode"
  | "onTurnStart"
  | "onTurnEnd"
  | "recordToolOutcome"
  | "searchMemory"
  | "getTrace"
  | "getPolicy"
  | "getWorldModel"
  | "listWorldModels"
  | "timeline"
  | "listSkills"
  | "getSkill"
>;
