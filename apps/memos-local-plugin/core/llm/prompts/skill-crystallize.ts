import type { PromptDef } from "./index.js";

/**
 * V7 §7.2 — Skill crystallization.
 *
 * When a policy has accumulated enough supporting evidence (support ≥
 * skill.minSupport) and enough reward lift (gain ≥ skill.minGain), promote
 * it into a callable "Skill" with a stable name, parameter schema, and a
 * small SKILL.md authored from the evidence.
 *
 * **v2** (this version) extends the schema with `decision_guidance`:
 * preference + anti-pattern lists distilled from past failures + fixes
 * (V7 §2.4.6). The crystallizer now sees the policy's `@repair` block
 * (parsed by the orchestrator from `policy.boundary`) plus high-V vs
 * low-V evidence traces, so the LLM can write concrete "prefer X /
 * avoid Y" lines that ship with the skill. Bumping the version captures
 * that shape change so the LLM-mock op tags refresh too.
 */
export const SKILL_CRYSTALLIZE_PROMPT: PromptDef = {
  id: "skill.crystallize",
  version: 2,
  description:
    "Turn a graduated L2 policy into a callable Skill definition, including decision guidance distilled from past prefer/avoid signals.",
  system: `You crystallize a skill an agent should be able to call.

Input:
- POLICY: the L2 policy being promoted (trigger / action / rationale / caveats).
- EVIDENCE: 3..10 successful traces that support the policy.
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
  "decision_guidance": {
    "preference":   ["Prefer: …", ...],   // concrete actions to favour, ≤ 5
    "anti_pattern": ["Avoid: …", ...]     // concrete actions to avoid, ≤ 5
  },
  "tags": ["optional string", ...]
}

Rules:
- Only reference tools/APIs that appear in EVIDENCE.
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
