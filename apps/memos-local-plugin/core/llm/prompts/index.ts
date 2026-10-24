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

export type PromptLanguage = "auto" | "zh" | "en";

/** Insert just before prompts, when we know the user-facing language. */
export function languageSteeringLine(lang: PromptLanguage): string {
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

/**
 * Detect whether generated knowledge should be written in Chinese or English.
 *
 * Used by knowledge-generation callers (skill crystallization, L2
 * induction, L3 abstraction, reflection synthesis) to decide whether to
 * emit generated knowledge in Chinese or English.
 *
 * Heuristic:
 *   - Count CJK Unified Ideographs (U+4E00..U+9FFF) as `zh`.
 *   - Count ASCII letters A-Z/a-z as `en`.
 *   - Treat Japanese kana as an explicit non-Chinese signal. This keeps
 *     Japanese prompts from being mistaken for Chinese just because they
 *     contain a few shared Han characters.
 *   - CJK characters carry a small weight because technical identifiers
 *     (package names, commands, file paths) can contribute many ASCII
 *     characters inside an otherwise Chinese sentence. If weighted CJK
 *     accounts for more than `zhRatioThreshold` of the signal, pick `zh`.
 *   - Otherwise pick `en`.
 *
 * This intentionally treats Japanese / Korean prompts with filenames,
 * paths, and model names as English for generated reflections instead
 * of misclassifying them as Chinese from shared CJK ideographs or as
 * auto from non-ASCII scripts we do not explicitly support.
 *
 * Deliberately small and allocation-free — this runs on every
 * knowledge-generation LLM call.
 */
export function detectDominantLanguage(
  samples: ReadonlyArray<string | null | undefined>,
  opts: { zhRatioThreshold?: number } = {},
): PromptLanguage {
  const zhRatioThreshold = opts.zhRatioThreshold ?? 0.6;
  let zh = 0;
  let en = 0;
  let kana = 0;
  for (const s of samples) {
    if (!s) continue;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) zh++;
      else if (
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0x31f0 && code <= 0x31ff)
      ) kana++;
      else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) en++;
    }
  }
  if (kana > 0) return "en";
  const total = zh + en;
  if (total === 0) return "en";
  const weightedZh = zh * 4;
  return weightedZh / (weightedZh + en) > zhRatioThreshold ? "zh" : "en";
}
