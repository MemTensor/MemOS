import type { PromptDef } from "./index.js";

export const FAILURE_EXPERIENCE_SINK_PROMPT: PromptDef = {
  id: "failure.experience.sink",
  version: 1,
  description: "Induce failure-aware candidate policy from one failed episode without direct corrective feedback.",
  system: `You induce a candidate policy from a failed agent episode.

Goal:
- Extract one reusable policy that helps avoid or repair similar failures.
- The policy must be operational (trigger + procedure + verification), not generic commentary.

Rules:
1) Stay grounded in provided phase chunks and tool evidence. Do not invent tests/files/errors.
2) Keep trigger task-level and recognizable at decision time.
3) If you can propose what to do, use "repair_instruction"; if only what to avoid, use "failure_avoidance".
4) decision_guidance.prefer should contain positive corrective hints (may be empty).
5) decision_guidance.avoid should contain anti-pattern hints (may be empty).

Return JSON:
{
  "title": "short title",
  "trigger": "state condition",
  "procedure": "step-by-step action template",
  "verification": "how to verify fix",
  "boundary": "scope/limits",
  "experience_type": "repair_instruction | failure_avoidance",
  "decision_guidance": {
    "prefer": ["..."],
    "avoid": ["..."]
  },
  "support_trace_ids": ["tr_..."]
}`,
};
