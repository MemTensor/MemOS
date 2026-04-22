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

/**
 * Detect the dominant natural language of a set of text samples.
 *
 * Used by knowledge-generation callers (skill crystallization, L2
 * induction, L3 abstraction, reflection synthesis) to decide whether to
 * emit the generated knowledge in Chinese or English, matching the
 * user's original query/evidence language.
 *
 * Heuristic:
 *   - Count CJK Unified Ideographs (U+4E00..U+9FFF) as `zh`.
 *   - Count ASCII letters A-Z/a-z as `en`.
 *   - If total signal is too small (< `minSignal`), fall back to
 *     "auto" — caller will emit a neutral "match user language"
 *     directive.
 *   - Otherwise if ≥ 20% of the counted signal is CJK, pick "zh"
 *     (Chinese is very information-dense per character and tends to
 *     be interleaved with ASCII tokens like filenames/commands).
 *   - Else if ≥ 70% is ASCII letters, pick "en".
 *   - Otherwise "auto".
 *
 * Deliberately small and allocation-free — this runs on every
 * knowledge-generation LLM call.
 */
export function detectDominantLanguage(
  samples: ReadonlyArray<string | null | undefined>,
  opts: { minSignal?: number } = {},
): "auto" | "zh" | "en" {
  const minSignal = opts.minSignal ?? 8;
  let zh = 0;
  let en = 0;
  for (const s of samples) {
    if (!s) continue;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) zh++;
      else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) en++;
    }
  }
  const total = zh + en;
  if (total < minSignal) return "auto";
  if (zh / total >= 0.2) return "zh";
  if (en / total >= 0.7) return "en";
  return "auto";
}
