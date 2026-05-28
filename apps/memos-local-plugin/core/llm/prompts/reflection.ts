import type { PromptDef } from "./index.js";

/**
 * V7 §3.2 — Windowed binary path-relevance scoring.
 *
 * One LLM call per episode window. The LLM sees the full causal chain of
 * the window in order and returns a binary `alpha ∈ {0, 1}` plus a fixed
 * `RELATED | IRRELEVANT` label per step. There is no natural-language
 * reflection synthesis: `traces.reflection` is overwritten by the label
 * (or `RELATED_DEFAULT` when the windowed pipeline falls back to its
 * episode-wide safe default).
 *
 * Window topology and retry ladder are owned by `core/capture/capture.ts`
 * (primary `batch=20, overlap=3` → degrade `batch=9, overlap=3` →
 * episode-wide `RELATED_DEFAULT` fallback). `core/capture/batch-scorer.ts`
 * validates each entry's shape and rejects any `alpha` that is not exactly
 * 0 or 1 / `relevance` that is not exactly RELATED|IRRELEVANT.
 */
export const BATCH_REFLECTION_PROMPT: PromptDef = {
  id: "reflection.batch",
  version: 4,
  description:
    "Binary path-relevance scoring for every step in one episode window.",
  system: `You are reviewing a WINDOW of one AI agent episode.

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
- "task_context": optional episode-level task summary.

The user payload may also include "host_context". That describes the host
agent being reviewed and the separate reflection model doing this review.

Goal: decide whether each step is RELEVANT to the final trajectory.
You must NOT produce long natural-language reflection text.

For EACH input step, return one object containing:
- "idx": copy the input idx exactly
- "alpha": MUST be integer 0 or 1 only
    * 1 => this step is effective and downstream steps continue from it
    * 0 => detour / ineffective / irrelevant to trajectory
- "relevance": MUST be one of "RELATED" or "IRRELEVANT"
- "reason": short code-like reason, <= 8 words (e.g. "ON_PATH", "DETOUR")

Return JSON of the form:
{
  "scores": [
    {"idx": 0, "alpha": 1, "relevance": "RELATED", "reason": "ON_PATH"},
    {"idx": 1, "alpha": 0, "relevance": "IRRELEVANT", "reason": "DETOUR"}
  ]
}

The "scores" array MUST contain exactly one entry per input step, in input
order. Do not skip steps. Do not invent extra entries.`,
};
