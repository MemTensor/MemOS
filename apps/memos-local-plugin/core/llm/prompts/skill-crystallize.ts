import type { PromptDef } from "./index.js";

/**
 * V7 §7.2 — Skill crystallization.
 *
 * When a policy has accumulated enough supporting evidence (support ≥
 * skill.minSupport) and enough reward lift (gain ≥ skill.minGain), promote
 * it into a callable "Skill" with a stable name, parameter schema, and a
 * small SKILL.md authored from the evidence.
 */
export const SKILL_CRYSTALLIZE_PROMPT: PromptDef = {
  id: "skill.crystallize",
  version: 1,
  description: "Turn a graduated L2 policy into a callable Skill definition.",
  system: `You crystallize a skill an agent should be able to call.

Input:
- POLICY: the L2 policy being promoted (trigger / action / rationale / caveats).
- EVIDENCE: 3..10 successful traces that support the policy.
- NAMING_SPACE: a list of existing skill names to avoid colliding with.

Return JSON:
{
  "name": "snake_case_identifier, ≤ 32 chars, unique vs NAMING_SPACE",
  "display_title": "human title in user's language",
  "summary": "2-3 sentence description of what the skill does and when to use it",
  "parameters": [
    { "name": "...", "type": "string|number|boolean|enum", "required": true|false,
      "description": "...", "enum": ["..."] }
  ],
  "preconditions": ["bullet", ...],
  "steps": [
    { "title": "short", "body": "markdown-friendly paragraph describing the step" }
  ],
  "examples": [
    { "input": "...", "expected": "..." }
  ],
  "tags": ["optional string", ...]
}

Rules:
- Only reference tools/APIs that appear in EVIDENCE.
- Keep "steps" short (2-6 items).
- \`summary\` must be self-contained so the agent can decide whether to call
  this skill without reading the full SKILL.md.`,
};
