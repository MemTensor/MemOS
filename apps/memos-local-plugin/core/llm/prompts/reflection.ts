import type { PromptDef } from "./index.js";

/**
 * V7 §3.2 — Windowed path-relevance scoring (tri-valued relevance).
 *
 * One LLM call per episode window. The LLM returns only:
 * - `idx`
 * - `relevance ∈ {IRRELEVANT, RELATED, PIVOTAL}`
 * - `reason` (short reason code)
 *
 * `alpha` is mapped in backend: IRRELEVANT=0, RELATED=0.5, PIVOTAL=1.
 * `RELATED_DEFAULT` is backend fallback only and must not be emitted by LLM.
 */
export const BATCH_REFLECTION_PROMPT: PromptDef = {
  id: "reflection.batch",
  version: 9,
  description:
    "Tri-valued path-relevance scoring for each step in an episode window.",
  system: `You are reviewing a WINDOW of one AI agent episode.

Payload top-level fields: "steps" (required, array) and "task_context"
(optional episode-level task summary). Each entry in "steps" has:
- "idx": step index (integer, 0-based, sequential)
- "state": what the agent saw before acting (user prompt / prior obs)
- "thinking": the LLM's chain-of-thought for this step. May be empty.
- "action": what the agent chose to do (assistant text)
- "tool_calls": tools invoked, with inputs + outputs + errorCode. May
                be empty. Tool usage + outcomes are first-class evidence.
- "outcome": the step's final observable outcome (last tool output,
             error, or "(assistant-only step)" for pure text turns)

Goal: decide each step's relevance to the final trajectory.
You must NOT produce long natural-language reflection text.

Hard override (must follow): if a step is purely social/polite phatic
exchange (praise, thanks, greetings, apologies, small talk — "you did
great", "thank you", "bye", etc.) and does not add task constraints,
technical decisions, executable actions, debugging evidence, or progress
toward completion, label it IRRELEVANT — even if sentiment is positive.

Scoring rubric (apply in order: IRRELEVANT vs on-path, then RELATED vs PIVOTAL):

- IRRELEVANT => off-path, ineffective, or social-only (see hard override above).
- RELATED => any step that is useful and on the task path. This is the default
  for on-path work. Do NOT reserve RELATED only for "deletable" steps; many
  RELATED steps are necessary, and deletion cost is NOT the criterion.
- PIVOTAL => a strict subset of RELATED: mark PIVOTAL only when the step is
  a path-critical turning point or foundational decision for the episode.
  Prefer few PIVOTAL labels per window. Typical PIVOTAL cases:
    * Prior exploration failed or stalled; this step finds the correct
      approach, root cause, or workable fix that later steps build on.
    * The step establishes the episode's core plan, architecture, constraints,
      or governing principles that shape how the rest of the task runs.
  Do NOT use counterfactual deletion ("if removed, major rework/failure") as
  the main test — many RELATED steps would also be costly to remove. Reserve
  PIVOTAL for steps that change direction or set the backbone of the solution,
  not for routine on-path execution (reading files, minor edits, status updates,
  generic tool calls that merely continue an already-correct plan).

Calibration examples (PIVOTAL is RELATIVE to prior steps in the window —
look at the sequence, not the step in isolation):

Sequence A — recovery after exploration:
  step 0: try \`from foo import bar\` -> ImportError
          -> RELATED, reason "EXPLORATION"
  step 1: try \`from foo.bar import baz\` -> ImportError
          -> RELATED, reason "EXPLORATION"
  step 2: grep project, discover \`bar\` lives under \`foo.utils.bar\`
          -> PIVOTAL, reason "ROOT_CAUSE"
          (prior two steps stalled; this step unblocks the rest)
  step 3: rewrite import -> tests pass
          -> RELATED, reason "EXECUTION"

Sequence B — plan anchor at the start:
  step 0: user gives vague request "build me a chat bot"
          -> IRRELEVANT, reason "NO_ACTION"
  step 1: after clarifying, lock in "FastAPI + WebSocket, single room"
          -> PIVOTAL, reason "PLAN_ANCHOR"
          (every later step is built on this architectural choice)
  step 2: scaffold the project directory
          -> RELATED, reason "EXECUTION"
  step 3: implement WebSocket handler
          -> RELATED, reason "EXECUTION"

Sequence C — routine on-path, NO PIVOTAL needed:
  step 0: read config.json
          -> RELATED, reason "READ_CONFIG"
  step 1: change port field 8080 -> 9090
          -> RELATED, reason "CONFIG_EDIT"
  step 2: restart service -> ok
          -> RELATED, reason "VERIFY"
  (Linear execution with no turning point. A window can legitimately
  contain zero PIVOTAL steps — do NOT force one.)

Output: a JSON object \`{"scores": [...]}\` with exactly one entry per input
step, in input order — no skips, no extras. Each entry:
- "idx": copy the input idx exactly
- "relevance": one of "IRRELEVANT" | "RELATED" | "PIVOTAL" (NEVER emit
  "RELATED_DEFAULT" — that label is backend-only)
- "reason": short code-like reason, <= 8 words (see calibration sequences
  above for example codes)`,
};
