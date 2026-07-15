import type { PromptDef } from "./index.js";

/**
 * V7 §7.2 — Skill crystallization.
 *
 * When a policy has accumulated enough supporting evidence (support ≥
 * skill.minSupport) and enough reward lift (gain ≥ skill.minGain), promote
 * it into a callable "Skill" with a stable name, parameter schema, and a
 * small SKILL.md authored from the evidence.
 *
 * **v3** adds an explicit `tools` output field: the LLM must declare which
 * tools/commands the skill invokes, constrained to the `EVIDENCE_TOOLS`
 * whitelist extracted from evidence trace `toolCalls`. This replaces the
 * old regex-based command-token heuristic in the verifier — coverage is now
 * a clean set-containment check (`draft.tools ⊆ evidenceTools`).
 *
 * v2 history: added `decision_guidance` (preference + anti-pattern).
 */
export const SKILL_CRYSTALLIZE_PROMPT: PromptDef = {
  id: "skill.crystallize",
  version: 3,
  description:
    "Turn a graduated L2 policy into a callable Skill definition, including decision guidance distilled from past prefer/avoid signals.",
  system: `You crystallize a skill an agent should be able to call.

Input:
- POLICY: the L2 policy being promoted (trigger / action / rationale / caveats).
- EVIDENCE: 3..10 successful traces that support the policy.
- EVIDENCE_TOOLS: the exhaustive list of tool/command names that actually
  appeared in the evidence traces' tool calls. This is the ground-truth
  whitelist — your \`tools\` output MUST be a subset of this list.
- COUNTER_EXAMPLES (optional): traces with V < 0 from the same context —
  failures the policy is meant to prevent.
- REPAIR_HINTS (optional): a JSON block { preference: [...], antiPattern: [...] }
  attached to the policy by the decision-repair pipeline. These are concrete
  "prefer / avoid" lines synthesised from earlier failures + user feedback;
  treat them as authoritative seeds for \`decision_guidance\` below.
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
  "tools": ["tool_or_command_name", ...],
  "decision_guidance": {
    "preference":   ["Prefer: …", ...],   // concrete actions to favour, ≤ 5
    "anti_pattern": ["Avoid: …", ...]     // concrete actions to avoid, ≤ 5
  },
  "tags": ["optional string", ...]
}

Rules:
- \`tools\` MUST only contain names from EVIDENCE_TOOLS. Never invent tool
  names that are not in the whitelist. Include every tool the skill's
  procedure actually invokes — omit tools not referenced in your steps.
- Keep "steps" short (2-6 items).
- \`summary\` must be self-contained so the agent can decide whether to
  call this skill without reading the full SKILL.md.
- For \`decision_guidance\`:
  - If REPAIR_HINTS is non-empty, fold each line in verbatim (or lightly
    normalised) — they are already grounded in evidence and user feedback.
  - You MAY add 1–2 extra entries derived from contrasting EVIDENCE
    (high-V) vs COUNTER_EXAMPLES (low-V), if they materially clarify the
    decision. Don't invent guidance unsupported by the inputs.
  - Each entry should be one short, actionable sentence (≤ 200 chars).
  - Empty arrays are fine when there's nothing to say — never fabricate.`,
};
