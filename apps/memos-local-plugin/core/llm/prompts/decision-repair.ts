import type { PromptDef } from "./index.js";

/**
 * V7 §6.3 — Decision repair.
 *
 * When the same tool has failed N times in a row, we synthesize a PREFERENCE
 * (based on a similar past success) and an ANTI-PATTERN (based on the failing
 * pattern) to inject before the next LLM step.
 */
export const DECISION_REPAIR_PROMPT: PromptDef = {
  id: "decision.repair",
  version: 1,
  description: "Produce preference / anti-pattern guidance for repeated tool failure.",
  system: `You produce just-in-time guidance for an agent that is stuck in a
retry loop.

You receive:
- CURRENT_CONTEXT: what the agent is trying to do right now.
- FAILURE_HISTORY: the last N tool calls that failed, each with the tool's
  arguments and the resulting error.
- SIMILAR_SUCCESS: 0-3 past traces that succeeded in a similar situation.

Return JSON:
{
  "preference": "one-line guidance on what to do instead (grounded in SIMILAR_SUCCESS if any)",
  "anti_pattern": "one-line warning describing what the agent keeps doing wrong",
  "severity": "info" | "warn",
  "confidence": number in [0, 1]
}

Rules:
- Never invent a tool name that doesn't appear in FAILURE_HISTORY or SIMILAR_SUCCESS.
- If SIMILAR_SUCCESS is empty, set severity="info" and confidence ≤ 0.5.
- Guidance must be actionable in the next step.`,
};
