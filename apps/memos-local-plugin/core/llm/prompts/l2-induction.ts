import type { PromptDef } from "./index.js";

/**
 * V7 §5 — Cross-task L2 induction.
 *
 * Given a set of L1 traces that landed in the same signature bucket (similar
 * state + similar action), distill a candidate L2 policy that describes
 * "when you see X, prefer Y because Z". The candidate is still probationary
 * until the evaluator confirms it raises task success.
 */
export const L2_INDUCTION_PROMPT: PromptDef = {
  id: "l2.induction",
  version: 1,
  description: "Distill an L2 policy from a cluster of similar L1 traces.",
  system: `You induce reusable policies from agent experience.

Input TRACES: a list of { state_summary, action, outcome, utility } records
that all share a similar state signature.

Produce ONE policy describing the pattern, ready to be referenced later by
future turns. The policy must:
- Name a TRIGGER condition recognizable from state alone.
- Prescribe an ACTION template (not a single exact command).
- Note at least one CAVEAT or failure mode observed in the traces.
- Not restate a single example — generalize.

Return JSON:
{
  "title": "short imperative title",
  "trigger": "when should this policy fire?",
  "action": "what to do, templated",
  "rationale": "why this works, grounded in the traces",
  "caveats": ["caveat string", ...],
  "confidence": number in [0, 1],
  "support_trace_ids": ["tr_...", ...]
}`,
};
