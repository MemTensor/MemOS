# core/reward — algorithm derivations

Mapping from V7 §0.6 / §2.4.2 / §3.3 to the code in this folder.

---

## V7 §0.6 — terminal reward `R_human` via rubric LLM

> *Equation (prose):* `R_human(h_k) = LLM_Score(h_k, task_summary_k, rubric) ∈ [-1, 1]`
>
> *Rubric axes:*
>   1. 目标达成度 — **goal_achievement** (did the task succeed?)
>   2. 过程质量 — **process_quality** (was the path reasonable?)
>   3. 用户满意信号 — **user_satisfaction** (emotion in feedback text)

### Our implementation

- `core/llm/prompts/reward.ts` holds `REWARD_R_HUMAN_PROMPT` (`reward.r_human`
  v2). The prompt explicitly asks for each axis in `[-1, 1]` plus a
  `label` (`success` | `partial` | `failure` | `unknown`) and a one-sentence
  `reason`.
- `core/reward/human-scorer.ts :: scoreHuman` validates each axis is a
  number, clamps to `[-1, 1]`, then combines with fixed weights:

  ```
  R_human = 0.45·goal_achievement
          + 0.30·process_quality
          + 0.25·user_satisfaction
  ```

  Weights are V7-aligned: goal achievement dominates (it's the primary
  RLHF-style signal), process quality tempers thrashing, satisfaction adds
  the human-in-the-loop anchor.

- **Heuristic fallback** (`heuristicScore`) is used when `llmScoring=false`,
  no LLM is wired, or the LLM throws. It only populates
  `user_satisfaction` from explicit-channel polarity/magnitude:

  ```
  sat = (±0.3 to ±1) · sign(polarity) · clamp(magnitude, 0, 1)
  R_human = clamp(sat, -1, 1)
  ```

  `goal_achievement` and `process_quality` are left at 0 because we can't
  reliably judge them from polarity alone.

### Task summary (rubric input B)

`core/reward/task-summary.ts :: buildTaskSummary` assembles:

```
USER_QUERY: <first user turn, ≤500 chars, one-line>

AGENT_STEPS (N):
  1. <tool_name or agent text snippet>
  2. …

FINAL_OUTCOME:
<last assistant turn, ≤800 chars>
```

Clipped to `cfg.summaryMaxChars` with a head+tail marker (preserves the
final outcome — "did it end well?" matters most). Deterministic, no LLM.

---

## V7 §0.6 — normalized credit backprop

> 当前实现口径（新公式）：
> - `f_t = (1 - λ) + λ · γ^(T - t)`
> - `recovery_t = 1 if α_t>0 and t>0 and α_{t-1}=0 else 0`
> - `r_t = 1 + δ · recovery_t`
> - `w_t = α_t · f_t · r_t`
> - `S = Σ_t w_t`
> - `V_t = 0 (if S=0) else (w_t / S) · R_human`

### Our implementation (`core/reward/backprop.ts`)

Implementation computes one normalized weight per step, then scales by
`R_human`:

- **α source**: `TraceRow.alpha` from capture (`0 / 0.5 / 1`), defensively
  clamped to `[0, 1]`.
- **fading term `f_t`**: mixes flat mass and temporal decay by `lambda`.
- **recovery boost `r_t`**: only applies when trajectory re-enters
  relevant path (`α: 0 → >0`).
- **normalization**: `Σ V_t = R_human` whenever `S>0`; all values stay in
  `[-1, 1]` after scaling.
- **degenerate case**: `S=0` (all `α=0`) writes `V_t=0` for all steps.

> 旧递推公式 `V_t = α_t·R_human + (1-α_t)·γ·V_{t+1}` 已废弃，不再作为实现口径。

---

## V7 §3.3 — retrieval priority with time decay

> *Equation:* `priority(f¹) ∝ max(V, 0) · decay(Δt)`
> *Decay used:* `0.5^(Δt / halfLife)` (exponential half-life form).

### Our implementation

```ts
const dtDays = max(0, (now - trace.ts) / 86_400_000);
const decay = pow(0.5, dtDays / halfLifeDays);
const priority = max(V, 0) * decay;
```

- `max(V, 0)` ensures negative-value traces get **priority = 0** — they
  sink to the bottom of retrieval, but are **never deleted** (V7 §2.4.5
  "低价值 trace 自然沉底但永久保留"). Decision Repair can still surface them
  via its explicit anti-pattern lookup in Phase 10.
- `halfLifeDays` is user-tunable via `algorithm.reward.decayHalfLifeDays`
  (default 30d). Half-life of 30 days means a 1.0-value trace from one
  month ago competes with a 0.5-value trace from now.
- Exported as `priorityFor(value, ts, halfLife, now)` for:
  - tier-2 retrieval reranking (Phase 8) without re-running backprop;
  - periodic "reage" sweeps in the L3 abstractor.

---

## Trigger semantics (Phase 7 subscriber)

The V7 spec leaves *when* to run backprop flexible — the only constraint
is that it must eventually happen, and preferably once per "task-level
feedback process". We implement that with a small state machine:

```
capture.done ──────────▶ pending{episodeId}
       │
       │ cfg.feedbackWindowSec > 0
       ▼
  setTimeout(run implicit_fallback)
       ▲
       │ clearTimeout if submitFeedback comes first
       │
explicit user feedback ▶ run explicit_feedback (merges prior pending row list)
```

- **`trigger` field** on the run is metadata only; downstream consumers
  can decide e.g. to wait for explicit feedback before crystallising a
  Skill (V7 §2.4.5 "修正型反馈是最有价值的学习信号").
- A second explicit feedback after a run has already completed re-runs
  backprop (idempotent: new `R_human` overwrites previous trace values).

---

## Diffs from V7 prose (deliberate)

1. **Per-axis output in the prompt.** V7 says "LLM 按 rubric 对三个维度分别打分后加权合并"
   but implies a single scalar. We keep the per-axis output because the viewer
   needs to explain "why R_human is low" — essential for the user-feedback loop.
   The combined `R_human` remains the authoritative scalar.

2. **Heuristic fallback.** V7 assumes an LLM always exists. In
   `memos-local-plugin` the LLM is optional; we fall back to a conservative
   polarity mapping that reaches only `user_satisfaction`, leaving the
   other two axes at 0. Avoids overestimating the agent when no model is
   available.

3. **Priority lower bound.** V7 §3.3 uses `max(V, 0)` which gives
   priority = 0 for `V < 0`. We explicitly return `0` rather than a tiny
   positive `ε` — the retrieval tier-2 sorter treats 0 as "hidden by
   default" but still visible on `includeLowValue=true`.

4. **Trigger metadata.** V7 doesn't model "when the run happens"; we do,
   because the viewer needs to distinguish user-driven vs. auto-fallback
   scoring for the progress panel.

All deviations are additive — swap `trigger` for `undefined` and force
the LLM, and our code exactly matches the spec.
