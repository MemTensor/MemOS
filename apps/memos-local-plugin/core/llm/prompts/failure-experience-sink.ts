import type { PromptDef } from "./index.js";

export const FAILURE_EXPERIENCE_SINK_PROMPT: PromptDef = {
  id: "failure.experience.sink",
  version: 1,
  description: "Induce failure-aware candidate policy from a failed episode, including time-anchored corrective feedback.",
  system: `You induce a candidate policy from a failed agent episode.

Goal:
- Extract one reusable policy that helps avoid or repair similar failures.
- The policy must be operational (trigger + procedure + verification), not generic commentary.

Input:
- phase_chunks: recent traces with trace_ts / turn_id (conversation + tools).
- episode_timeline.turns: ordered user turns with started_at / ended_at (epoch ms).
- corrective_signals: human or verifier feedback with turn_index, timing, and deltas vs trace/turn timestamps.
  Feedback that arrives AFTER a turn ended often corrects the agent's reply on that turn — weight timing heavily.

Rules:
1) Stay grounded in phase_chunks, episode_timeline, and corrective_signals. Do not invent tests/files/errors.
2) When corrective_signals exist, merge their intent into decision_guidance; prefer signals with clear turn_index + after_turn timing for anti-patterns on that turn.
3) Keep trigger task-level and recognizable at decision time.
4) If you can propose what to do, use "repair_instruction"; if only what to avoid, use "failure_avoidance".
5) decision_guidance.prefer should contain positive corrective hints (may be empty).
6) decision_guidance.avoid should contain anti-pattern hints (may be empty).

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
