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

## V7 §3.2 — Windowed binary path-relevance scoring

The original per-step reflection scorer (`reflection-extractor` →
`reflection-synth` → `alpha-scorer`) was removed in the 2026-05 redesign
(see [docs/superpowers/specs/2026-05-27-l1-batch-reflection-binary-design.md](../../docs/superpowers/specs/2026-05-27-l1-batch-reflection-binary-design.md)).
Reflection no longer produces free-form natural-language text. Instead, every
step gets a fixed-label path relevance judgement and an aligned numeric `α`:

```
α_t ∈ {0, 0.5, 1}
reflection_t ∈ { "PIVOTAL", "RELATED", "IRRELEVANT", "RELATED_DEFAULT" }
```

with the semantics:
- `PIVOTAL` → `α_t = 1` —关键转折点。
- `RELATED` → `α_t = 0.5` —相关但非关键路径。
- `IRRELEVANT` → `α_t = 0` —无关/偏航路径。
- `RELATED_DEFAULT` → `α_t = 0.5` —missing-window 或 episode fallback 的安全默认值。

### Window topology

Windows are owned by `runEpisodeBatchScoring` in `capture.ts`. Two passes:

| Pass    | `windowSize` | `overlap` | per-window retries |
|---------|--------------|-----------|--------------------|
| primary | 20           | 3         | 1                  |
| degrade | 9            | 3         | 2                  |

Stride is `windowSize − overlap` (17 for primary, 6 for degrade). The
last window of either pass is allowed to be shorter than `windowSize`.
`buildWindows(length, windowSize, overlap)` returns half-open `[start,
end)` pairs in ascending order.

### Merge rule

`mergeWindowScores` aggregates per-window results by absolute
`global_idx = win.start + i`. Per-step combination is:

Window overlap 合并按标签优先级（已替代旧的二值 merge 口径）：

```
PIVOTAL > RELATED / RELATED_DEFAULT > IRRELEVANT
```

Numeric `alpha` follows final label mapping:

```
PIVOTAL=1, RELATED=0.5, RELATED_DEFAULT=0.5, IRRELEVANT=0
```

> 旧口径（`alpha=1` 覆盖 `alpha=0`，且 missing-window 默认 `alpha=1`）已废弃。

### Failure ladder

1. **Per-window** — up to `maxRetries+1` calls (1 attempt + retries).
   A malformed payload from the LLM is one of: array length ≠ window
   length, `relevance` outside {IRRELEVANT, RELATED, PIVOTAL}, or
   missing `idx`. The validator in
   `batch-scorer.ts :: validateBatchPayload` raises
   `LLM_OUTPUT_MALFORMED` and the facade's own malformed-retry triggers
   once before our outer retry kicks in. A missing/empty `reason` is
   NOT malformed — the entry is kept and we emit a `batch.reason_missing`
   warn instead, so a stray reason omission never costs the whole
   episode its (relevance, alpha) signal.
2. **Window pass** — if every window in the primary pass eventually
   succeeded, we accept its results. Otherwise we discard the partial
   primary results and re-run with the degrade pass over the whole
   episode.
3. **Episode-wide fallback** — if the degrade pass also has any failed
   window, every step in the episode is overwritten with
   `{ alpha: 0.5, text: "RELATED_DEFAULT", reason: "FALLBACK_RELATED_DEFAULT" }`
   and we log `reflection_fallback_related_default` at error level with
   `{ degraded: true, episodeId, stepsCount, failedWindows }`.
4. **No reflect LLM wired** — short-circuits straight to the
   episode-wide fallback (`reason: "no_llm"`).

The downstream reward / L2 / Skill chain runs in every case; the
fallback is meant to keep the pipeline available, not to gate it.

### Bookkeeping (`CaptureResult.llmCalls`)

- `batchedReflection` — number of successful batch calls this episode.
  One per window that actually returned a usable payload (so a long
  episode can be >1, and the degrade pass can add more).
- `reflectionSynth` / `alphaScoring` — permanently `0`. Retained on the
  `CaptureResult` interface for backward-compatible analytics consumers.

### Stable prompt fingerprint

```
op = capture.reflection.batch.v<BATCH_REFLECTION_PROMPT.version>
```

Bumping `BATCH_REFLECTION_PROMPT.version` in
`core/llm/prompts/reflection.ts` rolls the op tag automatically so audit
rows stay attributable to a specific prompt revision.

## V7 §3.2.4 — Reward wiring

Capture does NOT compute `r_step` or `V_t`. It writes:

```
trace.value    = 0            # V_t will be filled by Phase 7
trace.r_human  = null         # assigned on feedback (Phase 7 R_human path)
trace.alpha    = α_t          # {0, 0.5, 1} from relevance mapping
trace.priority = 0.5          # seeded so retrieval can find it pre-reward
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

Capture initialises `priority=0.5`. The formula activates in
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
  rationales that the windowed scorer already collapses into a binary
  judgement).

Per-tool-call outputs use the same clamp with `maxToolOutputChars`.

## Concurrency

The windowed scorer is sequential per episode (windows run in order,
not in parallel) because the merge rule benefits from short feedback
loops on failures — a failing primary pass is detected before the
degrade pass starts. Summariser and embedder stages still use
`config.capture.llmConcurrency` workers (default 4).

Typical budget for a 60-step episode with the primary pass succeeding:
`ceil((60 - 3) / 17) = 4` batch calls, plus one embed call. Wall clock
is dominated by the batch latency of the reflect model.

## Downstream consumers and the enum reflection field

`traces.reflection` is now one of `PIVOTAL | RELATED | IRRELEVANT |
RELATED_DEFAULT` (plus legacy free-form text from pre-2026-05 traces).
Downstream modules that previously fed the reflection string into LLM
prompts, error-signature heuristics, or keyword blobs use the
`reflectionAsText` helper exported from `core/capture/types.ts` to
filter the three fixed labels back to `null`. That keeps the L2
signature bucket, L2/L3 induction prompts, skill crystallisation /
verification, feedback evidence, and feedback-builder notes from
treating `RELATED_DEFAULT` as natural language.
