# core/reward — Phase 7 (R_human + reflection-weighted backprop)

> V7 §0.6 / §2.4.2 / §3.3. Converts user feedback into a per-episode
> scalar `R_human ∈ [-1, 1]`, then distributes credit backward over the
> episode's L1 traces using reflection weights `α_t` (from capture) and
> an exponential time-decay for the retrieval `priority`.

## 1. When it runs

Two triggers, both non-blocking:

1. **Auto fallback** — `capture.done` fires for an episode with ≥1 trace.
   The subscriber schedules a `feedbackWindowSec` timer. When it expires,
   we score with whatever feedback we have (often none → heuristic = 0).
2. **Explicit submit** — `adapter.onFeedback` → feedback repo → the
   orchestrator calls `subscription.submitFeedback(row)`. The timer is
   cancelled and the run starts immediately with `trigger="explicit_feedback"`.

Either way the run is async and logged to `core.reward.*` channels; failures
are reported via `onError` and surfaced as `reward.failed` events.

## 2. Inputs

| From                     | Shape                                                          |
|--------------------------|----------------------------------------------------------------|
| `episodesRepo.getById`   | `EpisodeRow + meta` (used to look up trace ids & build summary)|
| `tracesRepo.getManyByIds`| `TraceRow[]` sorted chronologically                            |
| `feedbackRepo.getForEpisode` | persisted `FeedbackRow[]` (merged with caller list)        |
| Optional `EpisodeSnapshot` | fresher in-memory turns (for summary building)               |

The caller can also pass `UserFeedback[]` directly to `runner.run(...)`; we
merge with the repo list and drop duplicates by id.

## 3. Pipeline (one run)

```
runner.run({episodeId, feedback, trigger})
  ├─ task-summary.build               → TaskSummary (≤ cfg.summaryMaxChars)
  ├─ human-scorer.score               → HumanScore {rHuman, axes, source, model}
  │    ├─ LLM mode (default):  REWARD_R_HUMAN_PROMPT (rubric v2)
  │    │                       → 3 axes in [-1,1] → weighted mean → clamp
  │    └─ heuristic fallback:  polarity+magnitude mapping (no LLM needed)
  ├─ backprop.compute                  → V_t + priority per trace
  ├─ tracesRepo.updateScore (per trace)
  ├─ episodesRepo.setRTask   + updateMeta({reward:{…}})
  └─ emit: reward.scheduled → reward.scored → reward.updated
```

A failed LLM call **never** throws; we log + downgrade to heuristic. A
failed DB write is captured in `result.warnings[]` and reported but the
run is not aborted.

## 4. Formulas

- **R_human combination** (weights documented in `human-scorer.ts`):

  `R_human = 0.45·goal_achievement + 0.30·process_quality + 0.25·user_satisfaction`

- **Reflection-weighted backprop** (V7 §0.6 eq. 4/5):

  `V_T = R_human`
  `V_t = α_t · R_human + (1 − α_t) · γ · V_{t+1}`

- **Priority with time decay** (V7 §3.3):

  `priority(f1_t) = max(V_t, 0) · 0.5^(Δt_days / halfLifeDays)`

`priorityFor(value, ts, halfLife, now)` is exposed for downstream modules
(retrieval tier-2, L3 abstraction) that need to reweight without re-running
backprop.

## 5. Configuration (`algorithm.reward.*`)

| Key                    | Default | Meaning                                         |
|------------------------|---------|-------------------------------------------------|
| `gamma`                | 0.9     | γ discount factor                               |
| `tauSoftmax`           | 0.5     | τ for softmax reweighting in L2 induction (Phase 9 uses) |
| `decayHalfLifeDays`    | 30      | Half-life for priority decay                    |
| `llmScoring`           | true    | Use LLM rubric (v2); off = heuristic only       |
| `implicitThreshold`    | 0.2     | Fire-or-not threshold for implicit signals (reserved for classifier) |
| `feedbackWindowSec`    | 600     | Time to wait after `capture.done` for explicit feedback; 0 disables |
| `summaryMaxChars`      | 2000    | Cap on the task-summary string fed to the LLM   |
| `llmConcurrency`       | 2       | Max parallel R_human LLM calls (reserved for pool scheduler) |

All documented in `docs/CONFIG-ADVANCED.md`.

## 6. Public API

```ts
import {
  createRewardRunner,       // pipeline orchestrator
  attachRewardSubscriber,   // capture.done bridge + feedback ingestion
  createRewardEventBus,     // dedicated typed event bus
  backprop, priorityFor,    // pure helpers, safe to reuse in retrieval
  scoreHuman, heuristicScore,
  buildTaskSummary,
  type RewardResult, type UserFeedback, type RewardConfig, …
} from "memos-local-plugin/core/reward";
```

## 7. Events (`RewardEventBus`)

| Kind               | When                                            |
|--------------------|-------------------------------------------------|
| `reward.scheduled` | Run accepted; episode lookup succeeded.         |
| `reward.scored`    | After R_human computed (LLM or heuristic).      |
| `reward.updated`   | Persist finished. Payload: full `RewardResult`. |
| `reward.failed`    | Unhandled error (also logged at `error`).       |

The subscriber only listens to the capture bus for `capture.done`. The
orchestrator (Phase 15) will bridge `reward.updated` into downstream
consumers (L2 incremental induction, skill η updater, viewer SSE).

## 8. Persistence contract

Each run writes in one transaction-less sequence (storage layer is already
WAL-serialised):

| Row                  | Field(s) written                                       |
|----------------------|--------------------------------------------------------|
| `traces`             | `value`, `alpha` (echoed), `priority`                  |
| `episodes`           | `r_task` (= R_human)                                   |
| `episodes.meta_json` | `{reward: {rHuman, source, axes, reason, scoredAt, trigger}}` |

Audit log: each `reward.updated` also gets captured by the logger at INFO
into `logs/app.log` + events.jsonl (channel `core.reward`).

## 9. Tests

| Test                               | Covers                                |
|------------------------------------|---------------------------------------|
| `backprop.test.ts`                 | V_t formula, γ/α clamping, empty list, decay math |
| `task-summary.test.ts`             | Truncation, placeholders, step one-liners |
| `human-scorer.test.ts`             | LLM happy path, clamp, validate rejection, fallback, explicit channel |
| `events.test.ts`                   | Pub/sub, error isolation, listener count |
| `subscriber.test.ts`               | Capture bridge, window timer, explicit submit, stop/drain, onError |
| `reward.integration.test.ts`       | End-to-end against real SQLite; trace + episode + meta persisted |

Run: `npx vitest run tests/unit/reward`.
