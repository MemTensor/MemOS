import type { PromptDef } from "./index.js";

/**
 * V7 §3.2 — Windowed path-relevance scoring (tri-valued relevance).
 *
 * One LLM call per episode window. The LLM returns only:
 * - `idx`
 * - `relevance ∈ {IRRELEVANT, RELATED, PIVOTAL}`
 * - `reason` (short reason code)
 *
 * `alpha` is mapped in backend: IRRELEVANT=0, RELATED=0.5, PIVOTAL=1.
 * `RELATED_DEFAULT` is backend fallback only and must not be emitted by LLM.
 */
export const BATCH_REFLECTION_PROMPT: PromptDef = {
  id: "reflection.batch",
  version: 6,
  description:
    "Tri-valued path-relevance scoring for each step in an episode window.",
  system: `You are reviewing a WINDOW of one AI agent episode.

INPUT: a JSON array under "steps". Each entry has:
- "idx": step index (integer, 0-based, sequential)
- "state": what the agent saw before acting (user prompt / prior obs)
- "thinking": the LLM's native chain-of-thought for this step
               (Claude extended-thinking / pi-ai ThinkingContent). May
               be empty string.
- "action": what the agent chose to do (assistant text)
- "tool_calls": the tools invoked, with inputs + outputs + errorCode.
                May be empty array. Tool usage + outcomes are
                first-class evidence for scoring the step.
- "outcome": the step's final observable outcome (last tool output,
             error, or "(assistant-only step)" for pure text turns)
- "task_context": optional episode-level task summary.

The user payload may also include "host_context". That describes the host
agent being reviewed and the separate reflection model doing this review.

Goal: decide each step's relevance to the final trajectory.
You must NOT produce long natural-language reflection text.

For EACH input step, return one object containing:
- "idx": copy the input idx exactly
- "relevance": MUST be one of "IRRELEVANT", "RELATED", "PIVOTAL"
    * IRRELEVANT => detour / ineffective / not on useful path
    * RELATED => useful on-path support step
    * PIVOTAL => key turning point, removing it would cause major rework/failure
    * IMPORTANT: NEVER output "RELATED_DEFAULT"
- "reason": short code-like reason, <= 8 words (e.g. "ON_PATH", "DETOUR")

Return JSON of the form:
{
  "scores": [
    {"idx": 0, "relevance": "RELATED", "reason": "ON_PATH"},
    {"idx": 1, "relevance": "PIVOTAL", "reason": "RECOVERY"},
    {"idx": 2, "relevance": "IRRELEVANT", "reason": "DETOUR"}
  ]
}

The "scores" array MUST contain exactly one entry per input step, in input
order. Do not skip steps. Do not invent extra entries.`,
};
