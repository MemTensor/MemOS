# `core/session/` — algorithms

Two real decisions live here. Everything else is lifecycle bookkeeping.

## 1. Intent classifier — `intent-classifier.ts` (V7 §2.6 plan override)

The classifier decides, for the **first** user message of a fresh
episode, which retrieval tiers the orchestrator should fire:

| Kind           | Retrieval plan   | Meaning                                   |
| -------------- | ---------------- | ----------------------------------------- |
| `task`         | T1 + T2 + T3     | Wants the agent to DO something.          |
| `memory_probe` | T1 + T2          | Asks about past context.                  |
| `chitchat`     | *(skip)*         | Filler — don't retrieve.                  |
| `meta`         | *(skip)*         | Plugin command; adapter handles it.       |
| `unknown`      | T1 + T2 + T3     | Safe default: full retrieval.             |

### Decision flow

```
input.trim() == ""          → chitchat    (0.9)
strong heuristic ≥ 0.85     → use it
LLM available               → completeJson tiebreaker
LLM failed → strongest weak heuristic (fallback)
else                        → unknown     (0.4)
```

Heuristics are regex rules in `heuristics.ts`; see their `confidence`
field for the cut-off. The LLM prompt (`INTENT_SYSTEM` in
`intent-classifier.ts`) enforces exactly 5 vocabulary labels and a
structured JSON response with `validate` in `completeJson`.

### Cost + latency

- Heuristic path: ~0.1 ms (rule scan).
- LLM path: ~700–2000 ms (provider-dependent); capped by
  `timeoutMs` (default 6 000 ms). A timeout falls back to the strongest
  heuristic.
- The classifier is invoked once per episode open, never mid-turn.

## 2. Relation classifier — `relation-classifier.ts` (V7 §0.1)

Given the new user text and the previous episode's `q_k + ŷ_k`,
classifies the relationship as one of:

| `revision`  | Correction — same session, **reopen** previous episode. `R_human` back-propagates to existing L1 traces. |
| `follow_up` | Same domain, new sub-task — same session, **new** episode.                                                 |
| `new_task`  | Unrelated topic — **new session**, new episode.                                                            |
| `unknown`   | Safe default: treat as `follow_up`.                                                                         |

### Decision flow

```
no prev user text                       → new_task (0.75)  (bootstrap)
heuristic with confidence ≥ 0.80        → use it
LLM available                           → completeJson tiebreaker
LLM failed → strongest weak heuristic (fallback, tagged `llm_skipped`)
else                                    → follow_up (0.45) (safest middle ground)
```

### Heuristic rules

| Rule id                 | Fires on                                                 | Kind        | Conf. |
| ----------------------- | -------------------------------------------------------- | ----------- | ----- |
| `r1_negation_keyword`   | `不对` / `wrong` / `redo` / `not quite` / `instead`       | revision    | 0.85  |
| `r2_quotes_prev`        | Quotes ≥ 8-word phrase of prev assistant text verbatim   | revision    | 0.75  |
| `r3_follow_phrase`      | `再…` / `next` / `also` / `another similar`              | follow_up   | 0.80  |
| `r4_new_phrase`         | `现在另一个` / `new topic` / `forget that`                 | new_task    | 0.85  |
| `r5_time_gap`           | `gapMs > 30 min` since previous episode                  | new_task    | 0.60  |
| `r6_domain_shift`       | No overlap between new text and previous episode tags    | new_task    | 0.55  |

The strongest rule wins when multiple fire. Rules 5/6 are below the
strong threshold and only produce a decision if the LLM is unavailable
*and* no stronger rule fired.

### Observability

Both classifiers emit structured logs at `INFO`:

- `core.session.intent.heuristic.strong` / `.llm.ok` / …
- `core.session.relation.heuristic.strong` / `.llm.ok` / …

The pipeline orchestrator additionally emits an
`episode.relation_classified` event on the `SessionEventBus`, so the
viewer can surface which relation was chosen and why.

### Failure mode

If both heuristic and LLM fail, the classifier returns `unknown` (intent)
or `follow_up` (relation) — never throws. The caller (orchestrator) is
expected to continue with full retrieval / a new episode in that case.

## Tests

- `tests/unit/session/heuristics.test.ts` — intent rule table.
- `tests/unit/session/session-manager.test.ts` — lifecycle + intent integration.
- `tests/unit/session/relation-classifier.test.ts` — V7 §0.1 rules +
  LLM tiebreaker + timeout fallback.
