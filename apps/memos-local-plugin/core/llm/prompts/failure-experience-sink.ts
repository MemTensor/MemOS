import type { PromptDef } from "./index.js";

export const FAILURE_EXPERIENCE_SINK_PROMPT: PromptDef = {
  id: "failure.experience.sink",
  version: 5,
  description:
    "Induce reusable task-completion guidance from a failed attempt and corrective feedback.",
  system: `You induce a candidate policy from an episode where the task was not finished satisfactorily.

Goal:
- Extract one reusable policy that helps a similar task reach a satisfactory finish.
- Make it operational: trigger + procedure + verification. Prefer practical guidance (priorities, sequencing, closure checks) over abstract commentary.
- Use corrective_signals to see what the goal still needed; use phase_chunks and episode_timeline for context.

Input:
- task_context.user_goal: task framing and requirements (may be truncated).
- phase_chunks: recent traces (conversation + limited tool output snippets).
- episode_timeline.turns: ordered user turns with timing.
- corrective_signals: feedback with turn_index and timing relative to turns.

Evidence:
1) Ground only in the fields above. Do not invent tests, files, errors, or violations.
2) task_context states requirements; it does not by itself show what went wrong in the attempt.
3) Tie each claim to a quotable phenomenon (e.g. external judgment still open, requested substance missing, timeout without deliverable, feedback naming an unmet acceptance criterion).
4) If evidence is thin, keep the policy narrow and note limits in boundary.
5) Source-specific entities are not reusable guidance by default: names, locations, product names, file names, one-off requested targets, and one task's acceptance details must be abstracted into categories or variables.
6) Preserve an entity only when the input explicitly marks it as a structured stable fact, such as a user profile fact, workspace/project fact, long-term preference memory, or stable-fact annotation.
7) Current episode text, tool output, verifier feedback, or a one-time task requirement are not enough evidence to call an entity long-term. Do not infer long-term preference from them.
8) Do not put source-specific entities into title, trigger, procedure, verification, boundary, or decision_guidance unless the structured stable source is present.

Guidance:
9) prefer: habits that advance completion (may be empty).
10) avoid: habits that leave the goal unmet—outcome/behavior gaps only. Do not name tools or channels; do not use "do not use / never call" style lines.
11) procedure and verification must be checkable from visible outcomes or judgments in the input.
12) verification: how to tell the task is done or accepted.

Types:
13) "failure_avoidance" when feedback shows the goal stayed open and you mainly generalize what to stop doing before ending.
14) "repair_instruction" when you can give a repeatable completion pattern (what to finish or confirm before done).

Other:
15) trigger: task-level, recognizable when a similar task starts or nears closure.
16) support_trace_ids: only traces you actually used.

Return JSON:
{
  "title": "short title",
  "trigger": "state condition",
  "procedure": "step-by-step guidance",
  "verification": "how to verify completion",
  "boundary": "scope/limits",
  "experience_type": "repair_instruction | failure_avoidance",
  "decision_guidance": {
    "prefer": ["..."],
    "avoid": ["..."]
  },
  "support_trace_ids": ["tr_..."]
}`,
};
