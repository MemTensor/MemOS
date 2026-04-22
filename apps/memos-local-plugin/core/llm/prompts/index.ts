/**
 * Prompt registry. Every prompt is exported as a versioned constant so that
 * downstream records (`audit_events`, `skills`, `traces`) can store a
 * pointer (`promptId@version`) instead of a full copy. When a prompt is
 * revised, bump its `version` and the caller will automatically start
 * recording the new id.
 *
 * Keep prompts in this file tree in English by default — models are much
 * happier that way — and let the user-language steering happen via a
 * separate "LANGUAGE" system line injected by callers.
 */

export interface PromptDef {
  id: string;
  version: number;
  description: string;
  system: string;
}

export { REFLECTION_SCORE_PROMPT, BATCH_REFLECTION_PROMPT } from "./reflection.js";
export { REWARD_R_HUMAN_PROMPT } from "./reward.js";
export { L2_INDUCTION_PROMPT } from "./l2-induction.js";
export { L3_ABSTRACTION_PROMPT } from "./l3-abstraction.js";
export { DECISION_REPAIR_PROMPT } from "./decision-repair.js";
export { SKILL_CRYSTALLIZE_PROMPT } from "./skill-crystallize.js";
export { RETRIEVAL_FILTER_PROMPT } from "./retrieval-filter.js";

/** Insert just before prompts, when we know the user-facing language. */
export function languageSteeringLine(lang: "auto" | "zh" | "en"): string {
  switch (lang) {
    case "zh":
      return "All natural-language answers MUST be in 简体中文 (zh-CN).";
    case "en":
      return "All natural-language answers MUST be in English.";
    case "auto":
    default:
      return "Answer in the same natural language the user used. Do not mix languages.";
  }
}
