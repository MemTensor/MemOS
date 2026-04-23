# core/capture — algorithms

Derivation companion to `README.md`. Maps each formula in V7 §3.2 to the
file / symbol that implements it.

## V7 §3.2.1 — Step identification

Formally, V7 defines an episode `E = {τ₁, τ₂, …, τ_T}` where each `τ_t`
is either a pure assistant response or a tool-call+tool-result pair.
`step-extractor.ts` walks `EpisodeSnapshot.turns` and groups them:

```
segment_boundary := role == "user" AND currentSegment.hasAssistant
```

That is, a new `user` turn closes the current segment only if we've
already seen at least one assistant turn. Consecutive user turns (rare,
usually a clarification) merge into one segment's `userText`.

Edge cases:
- **No assistant turn ever** → synthetic skeletal step so Phase 7 has an
  anchor (V7 §3.2.6 recommends one reward per episode).
- **Tool-first segments** (tool turn before any assistant) → the tool
  content becomes an upstream observation merged into `userText`.
- **Sub-agent hops** → extractor propagates `meta.depth` / `meta.isSubagent`.
  The V7 spec keeps all sub-agent traces under the root episode so
  `R_task` backprops correctly up the decision tree.

## V7 §3.2.2 — Reflection extraction

Procedure `ExtractReflection(τ_t)`:

```
if τ_t.meta.reflection is non-empty:
    return τ_t.meta.reflection          # adapter-native
elif regex_match(τ_t.agentText):
    return cleaned_match(…)             # inline reasoning
elif config.synthReflections:
    return LLM(Synthesis, τ_t)          # synthesized
else:
    return ∅
```

Implemented by `reflection-extractor.ts` (steps 1-2) +
`reflection-synth.ts` (step 3). Prompt for synthesis is minimal and
temperature=0.1 — we want a terse, agent-voiced explanation, never a
judgment.

## V7 §3.2.3 — α scoring

V7 defines the "reflection utility" α via a four-axis rubric:

```
α_t = judge(state_t, action_t, outcome_t, reflection_t)
    = weighted_mean(faithfulness, causal_insight,
                    transferability, concreteness)
usable_t = 1 iff α_t ≥ 0.4 AND non_tautological(reflection_t)
if usable_t = 0:
    α_t ← 0          # equation 5: unusable reflections cannot skew backprop
```

The judge is `REFLECTION_SCORE_PROMPT` (see
`core/llm/prompts/reflection.ts`), which returns a JSON object. Our
implementation clamps α to [0, 1], applies the `usable` mask, and
guarantees finite values.

When `alphaScoring=false` OR the LLM fails:

```
α_t = 0.5    # neutral; Phase 7 backprop still runs, half-weighted
usable_t = 1
```

This preserves the "graceful degradation" property V7 asks for: a local
setup without a paid LLM still accrues L1 traces with meaningful
priority once reward arrives.

## V7 §3.2 batched variant — `batch-scorer.ts`

The per-step path (`reflection-synth.ts` + `alpha-scorer.ts`) issues 2N
LLM calls per N-step episode. `batch-scorer.ts` collapses them into ONE:

```
inputs   = [{idx, state, action, outcome, reflection, synth_allowed}, …]
                              ↓ BATCH_REFLECTION_PROMPT
outputs  = {scores: [{idx, reflection_text, alpha, usable, reason}, …]}
```

Dispatch (in `capture.ts`):

| `cfg.batchMode`   | `cfg.batchThreshold` | behavior |
|-------------------|----------------------|----------|
| `per_step`        | (ignored)            | legacy: 2N calls |
| `per_episode`     | (ignored)            | always batch |
| `auto` (default)  | `12`                 | batch when `N ≤ 12`; else per-step |

The dispatcher also refuses to batch when no LLM is wired — same fallback
path as missing-LLM in per-step mode.

Why batched mode tends to produce **better** reflections (not just cheaper):
the prompt sees the full episode timeline including the final outcome, so
it can credit-attribute across steps. V7 §3.2.3's `causal_insight` and
`transferability` axes both benefit from the wider context. Per-step
synth, in contrast, can only rationalize from local `(s, a, o)`.

Failure handling:

- LLM throws / facade gives up after `malformedRetries=1` → capture
  catches in `runBatchScoring`, surfaces a `{stage: "batch"}` warning,
  and the per-step path runs as a fallback.
- Validator rejects on length mismatch, missing/non-numeric `alpha`,
  non-boolean `usable`, non-string `reflection_text`. Same fallback.

Bookkeeping (`CaptureResult.llmCalls`):

- `batchedReflection`: 0 or 1 per episode (1 on a successful batch).
- `reflectionSynth` / `alphaScoring`: only nonzero when the per-step path
  ran (either selected directly, or as fallback after a batch failure).

Stable prompt fingerprint:

- `op = capture.reflection.batch.v1` (see `BATCH_OP_TAG` constant).
  Bumping `BATCH_REFLECTION_PROMPT.version` changes the op tag so audit
  rows remain attributable.

## V7 §3.2.4 — Reward wiring

Capture does NOT compute `r_step` or `V_t`. It writes:

```
trace.value    = 0            # V_t will be filled by Phase 7
trace.r_human  = null         # assigned on feedback (Phase 7 R_human path)
trace.alpha    = α_t          # from §3.2.3
trace.priority = 0            # recomputed after backprop
```

Phase 7 updates these via `tracesRepo.updateScore` once the
backpropagation pass finishes.

## V7 §3.3 — Priority formula

```
priority(f¹_t) ∝ max(V_t, 0) · decay(Δt)
```

- `Δt` = now − `trace.ts`
- `decay(Δt)` = half-life ≈ 30 days (Phase 7 constant)
- `V_t` = backpropagated value from the R_task + step rewards (Phase 7)

Capture initialises `priority=0`. The formula activates in
`core/reward/backprop.ts` (Phase 7).

## Text & vector conventions

- `userText` ≡ "state": what the agent saw before acting.
- `agentText + toolCalls` ≡ "action": what the agent did.
- `vec_summary` indexes **state** (`userText`). Used by Tier 2 recall
  when the next episode's user query is similarity-searched.
- `vec_action` indexes **action**. Used by decision-repair: when a tool
  fails N times, we search historical actions that succeeded on similar
  state.
- Both vectors are L2-normalised unit vectors in the embedder's
  configured dimension (default 384 for MiniLM).

## Truncation strategy

`clampText(s, maxChars)` keeps the head (55%) + tail (45%) joined by a
marker. Rationale:
- Head keeps "what the user asked" and the agent's opening intent.
- Tail keeps "what the agent concluded with" — often the most useful
  sentence for Tier 2 recall.
- Dropping the middle rarely hurts (that's usually thinking + tool
  rationales that the reflection already summarises).

Per-tool-call outputs use the same clamp with `maxToolOutputChars`.

## Concurrency

Reflection + α stages iterate per-step. We run them with
`config.capture.llmConcurrency` workers (default 4). The embedding stage
uses the embedder's own batching — one call for ALL steps.

Typical budget for a 10-step episode with alpha scoring on and an
external LLM: 10 α calls ÷ 4 workers ≈ 3 batches, plus one embed call.
Wall clock usually 3-10s on a mid-tier OpenAI-compat endpoint.

## Stable prompt fingerprints

Every LLM call carries:
- `op = capture.alpha.reflection.score.v1` (alpha scorer)
- `op = capture.reflection.synth` (reflection synth)

Bumping `REFLECTION_SCORE_PROMPT.version` in `core/llm/prompts/reflection.ts`
changes the op tag automatically, so historical α values remain
attributable to their scoring prompt generation.
