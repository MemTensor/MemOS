import type { PromptDef } from "./index.js";

/**
 * V7 §7.2 — Skill crystallization (fresh mint).
 *
 * v6: episode_outcome on evidence; failure traces belong in counter_examples only.
 * v5: SOP-from-episode framing, retrieval_blurb for Tier-1 search, names
 * derived from user queries + workflow (not policy.title).
 */
export const SKILL_CRYSTALLIZE_PROMPT: PromptDef = {
  id: "skill.crystallize",
  version: 6,
  description:
    "Turn graduated L2 evidence into a callable SOP-style skill with retrieval-oriented metadata.",
  system: `You crystallize a reusable SOP (standard procedure) an agent should follow.

The skill is NOT a copy of the policy title — it captures the **workflow** seen across evidence episodes: what the user asked, what tools were used, and the repeatable steps that worked.

Input:
- POLICY: L2 context (trigger / procedure / boundary) — background only; do not copy the policy title as the skill name.
- EVIDENCE: successful traces (user queries, agent actions, reflections). Mine **real user phrasing** from EVIDENCE for retrieval text.
- EVIDENCE_TOOLS: whitelist of tool names from traces — your \`tools\` output MUST be a subset.
- COUNTER_EXAMPLES (optional): failure-episode or low-V traces for anti-patterns only.
- Each evidence item includes episode_outcome ("success"|"failure"|"unknown") and episode_r_task.
- REPAIR_HINTS (optional): prefer / avoid seeds for \`decision_guidance\`.
- NAMING_SPACE: existing skill names to avoid.
- OUTPUT_LANGUAGE: "zh" | "en". All natural-language fields must use this language.

Return JSON:
{
  "name": "snake_case, ≤48 chars, pattern <domain>_<task>_<action>, describes the SOP capability (not policy.title)",
  "retrieval_blurb": "≤150 words: when to use this SOP + phrases users actually say (queries, file types, errors). Slightly proactive — include related intents even if the user did not name the skill. No step-by-step procedure here.",
  "trigger_context": "1-2 sentences in OUTPUT_LANGUAGE, paraphrasing when this SOP applies",
  "summary": "2-3 sentences: what this SOP accomplishes (execution only, no when-to-use)",
  "parameters": [
    { "name": "...", "type": "string|number|boolean|enum", "required": true|false,
      "description": "...", "enum": ["..."] }
  ],
  "preconditions": ["bullet", ...],
  "steps": [
    { "title": "short", "body": "markdown-friendly paragraph" }
  ],
  "examples": [
    { "input": "user query", "expected": "outcome" }
  ],
  "tools": ["tool_or_command_name", ...],
  "decision_guidance": {
    "preference":   ["Prefer: …", ...],
    "anti_pattern": ["Avoid: …", ...]
  },
  "tags": ["optional string", ...]
}

Rules:
- \`tools\` MUST only contain names from EVIDENCE_TOOLS.
- Name format MUST be snake_case and fit ≤48 chars.
- Keep "steps" short (2-6 items). Explain why when non-obvious; avoid ALL-CAPS MUST.
- Generalize from evidence — do not overfit to a single example query.
- \`retrieval_blurb\` must quote or paraphrase realistic user queries from EVIDENCE.
- Keep natural-language fields (\`retrieval_blurb\`, \`trigger_context\`, \`summary\`, \`steps\`, \`decision_guidance\`) in one language (OUTPUT_LANGUAGE).
- \`name\` stays snake_case capability identifier (<domain>_<task>_<action>), not free-form prose.
- For \`decision_guidance\`: fold REPAIR_HINTS when present; add at most 1-2 contrast lines from EVIDENCE vs COUNTER_EXAMPLES; never fabricate.
- EVIDENCE only contains success/unknown episode traces; never list a COUNTER_EXAMPLES trace as a step.
- Prefer traces with episode_outcome="success" when choosing steps.
- Each guidance line ≤200 chars; ≤5 per array.`,
};
