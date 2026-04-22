import type { PromptDef } from "./index.js";

/**
 * V7 §3.2 — Reflection scorer.
 *
 * Given an L1 trace (state, action, outcome, reflection_text), return a
 * quality score α_t ∈ [0, 1] and a boolean `usable` flag. The facade parses
 * the JSON output; we validate structure at the call site.
 */
export const REFLECTION_SCORE_PROMPT: PromptDef = {
  id: "reflection.score",
  version: 2,
  description: "Score an agent reflection for quality and usability, with full-step context.",
  system: `You are a strict reviewer of agent self-reflections.

You see the FULL context of one agent step:
- STATE        — what the agent saw before acting (user prompt, prior observation)
- THINKING     — the LLM's own native chain-of-thought for this step, if any
                  (Claude extended-thinking, pi-ai ThinkingContent). Empty when
                  the model didn't emit thinking this turn.
- ACTION       — what the agent produced (assistant text output)
- TOOL_CALLS   — tools the agent invoked this step, with inputs and outputs
                  (or errors). Tool usage + outcomes are part of the action
                  chain and carry their own signal about what the agent did.
- OUTCOME      — the final observable result of the step (last tool outcome
                  or "(assistant-only step)" for pure text turns)
- REFLECTION   — the text being graded: the agent's first-person explanation
                  of WHY it acted this way and WHAT it learned.

Score the REFLECTION on four axes, combined into ONE number α ∈ [0, 1]:

  1. faithfulness  — does the reflection match what ACTUALLY happened
                     across THINKING + ACTION + TOOL_CALLS + OUTCOME?
  2. causal insight — does it identify why the action / tool choice
                     worked or failed? Bonus when it connects the
                     model's visible THINKING to the resulting action.
  3. transferability — does it surface a lesson useful on a similar
                     future task?
  4. concreteness  — are the details specific (real command names,
                     real error messages, real decisions) rather than
                     generic platitudes like "I should do better"?

Rules:
- THINKING and TOOL_CALLS are first-class evidence for grading α —
  a reflection that ignores a visible thinking chain or misreports a
  tool call should score LOW on faithfulness.
- TOOL_CALLS that errored are strong signal: the reflection should
  name the error and what it implied. Missing that is a faithfulness
  penalty.
- An empty / purely-tautological reflection → α = 0, usable = false.
- α ≥ 0.4 AND reflection non-tautological → usable = true; else false.

Return JSON:
{
  "alpha": 0.0-1.0,
  "usable": true | false,
  "reason": "one-sentence justification"
}`,
};

/**
 * V7 §3.2 — *Batched* reflection synthesis + α scoring.
 *
 * One LLM call per episode instead of N synth + N α calls. The LLM sees the
 * complete causal chain (every step in order, including the final outcome),
 * which lets it write better-grounded reflections than per-step grounded
 * ones — V7 §3.2.3 axes "causal_insight" and "transferability" benefit
 * directly from the wider context window.
 *
 * Activated by `algorithm.capture.batchMode: "auto" | "per_episode"` in
 * `core/config`. The dispatcher in `core/capture/capture.ts` also enforces
 * `algorithm.capture.batchThreshold` so very long episodes degrade to the
 * per-step path instead of overflowing the prompt window.
 *
 * Output schema is documented inside the prompt — `core/capture/batch-scorer.ts`
 * validates each entry and falls back to per-step on any malformed value.
 */
export const BATCH_REFLECTION_PROMPT: PromptDef = {
  id: "reflection.batch",
  version: 2,
  description:
    "Score (and optionally synthesize) reflections for an entire episode in one call, with full thinking + tool-call context.",
  system: `You are reviewing every step of one AI agent episode in a single pass.

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
- "reflection": the agent's own first-person reflection (may be empty string)
- "synth_allowed": boolean — when true and "reflection" is empty, you SHOULD
  write a brand-new 2–3 sentence first-person reflection for that step. When
  false, leave "reflection_text" empty for steps that came in with empty
  "reflection".

For EACH input step, return one object containing:
- "idx": copy the input idx exactly
- "reflection_text":
    * If input "reflection" was non-empty → copy it verbatim, do not rewrite.
    * If input "reflection" was empty AND "synth_allowed" is true → write a
      NEW 2–3 sentence first-person explanation of WHY the agent acted this
      way and WHAT it learned. Concrete, no judgment, no repeating the
      visible action.
    * If input "reflection" was empty AND "synth_allowed" is false → return
      the empty string "".
    * If the step is incoherent or completely empty → return "".
- "alpha": one number in [0, 1] grading the reflection on:
    1. faithfulness — does it describe what actually happened across
       thinking + action + tool_calls + outcome? Missing or misnaming
       a visible thinking block / tool call / tool error is a penalty.
    2. causal insight — does it identify why the action or tool choice
       worked / failed? Bonus when it ties visible thinking to action.
    3. transferability — does it surface a lesson useful on a similar task?
    4. concreteness — are the details specific (real command names,
       real error messages) rather than generic platitudes?
  When "reflection_text" is empty, return alpha=0.
- "usable": true when alpha ≥ 0.4 AND the reflection is not tautological.
  When "reflection_text" is empty, return usable=false.
- "reason": one short sentence justifying the alpha score.

Knowing the FULL episode timeline (including the final outcome) is permitted
and encouraged — that is the whole point of batched scoring. Reflections
written here may show better causal insight than per-step ones because you
can see how each step contributed to the eventual result.

Return JSON of the form:
{
  "scores": [
    {"idx": 0, "reflection_text": "...", "alpha": 0.7, "usable": true, "reason": "..."},
    {"idx": 1, "reflection_text": "...", "alpha": 0.3, "usable": false, "reason": "..."}
  ]
}

The "scores" array MUST contain exactly one entry per input step, in input
order. Do not skip steps. Do not invent extra entries.`,
};
