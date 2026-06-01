import { detectDominantLanguage } from "../llm/prompts/index.js";
import type { PolicyRow } from "../types.js";
import type { SkillConfig } from "./types.js";

export type SkillOutputLanguage = "zh" | "en";

export function resolveSkillOutputLanguage(
  policy: Pick<PolicyRow, "title" | "trigger" | "procedure" | "boundary">,
  config: Pick<SkillConfig, "outputLanguageMode">,
): SkillOutputLanguage {
  const mode = config.outputLanguageMode ?? "follow_policy";
  if (mode === "zh" || mode === "en") return mode;
  const detected = detectDominantLanguage([
    policy.title,
    policy.trigger,
    policy.procedure,
    policy.boundary,
  ]);
  return detected === "zh" ? "zh" : "en";
}
