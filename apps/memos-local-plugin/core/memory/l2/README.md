# core/memory/l2 — Phase 9 (Cross-task L2 policy induction)

> V7 §0.5.2 / §2.4 / §2.4.1. Turns settled, reward-scored episodes into
> reusable **L2 policies** — short, named pieces of procedural know-how
> ("when you see X, do Y; verify Z") that generalise across tasks.
>
> Input: `reward.updated` fired by `core/reward`.
> Output: inserts/updates on `policies` + `l2_candidate_pool`, plus
> `L2Event`s for downstream subscribers (Skill crystallizer, viewer, audit).

## 1. When it runs

A single trigger: `reward.updated` on the `RewardEventBus`.
`attachL2Subscriber` listens, resolves the episode's traces, and calls
`runL2(input, deps)` asynchronously. Failures are caught, logged at
`error`, and surfaced as `l2.failed` events — they never bubble up and
crash the reward pipeline.

You can also call `runL2` directly for rebuilds or tests (the subscriber
exposes a `runOnce({ episodeId })` method that does exactly this).

## 2. Pipeline

```
runL2({episodeId, sessionId, traces, trigger})
  ├─ (filter) traces where V ≥ minTraceValue AND has embedding
  │
  ├─ 1. associate            → AssociationResult[]
  │      for each trace: topK active/candidate policies by cosine;
  │      keep the best score ≥ minSimilarity (blended with sig overlap)
  │
  ├─ 2. candidate pool       (bucket = pattern signature)
  │      unmatched traces → upsert into `l2_candidate_pool`
  │      row keyed by signatureHash(sig) + traceId; refresh TTL
  │
  ├─ 3. induce (LLM)         → InductionResult[]
  │      buckets with ≥ minEpisodesForInduction DISTINCT episodes:
  │        a. cheap dedup: if any trace cosine-matches an existing policy
  │                        above minSimilarity → skip, promote pool rows
  │        b. pick 1 strongest trace per episode → prompt `l2.induction`
  │        c. validate draft → insert as `candidate` policy (vec = centroid)
  │        d. promote pool rows (fill policy_id)
  │
  ├─ 4. gain + status         → for every touched policy:
  │      with-set:    traces associated with this policy in this episode
  │      without-set: all other traces in the episode (+ Bayesian prior)
  │      gain = weightedMean(with) − shrink(arithmeticMean(without))
  │             where shrink(x, n) blends x against a 0.5 neutral prior
  │             with a pseudocount of 5 (see core/memory/l2/gain.ts)
  │      status transitions via `nextStatus(currentSupport, gain, thresholds)`
  │      persist `support`, `gain`, `status`, `updated_at`
  │
  └─ emit: l2.trace.associated · l2.candidate.added · l2.policy.induced · l2.policy.updated
```

All four stages are timed; `result.timings` reports each phase + total
wall-clock so the viewer / perf log can graph "where did the 80 ms go".

## 3. Pattern signature

`signatureOf(trace)` returns a short, stable string used to bucket
candidates. See `signature.ts` for the full spec. Shape:

```
<primaryTag>|<secondaryTag>|<tool>|<errCode>
```

Example: `"docker|pip|pip.install|MODULE_NOT_FOUND"`.

- `primaryTag` / `secondaryTag` come from `trace.tags` (first two).
- `tool` is the first distinct tool called in the trace, normalized.
- `errCode` is extracted from the first error observation
  (e.g. `NETWORK_REFUSED`, `EXIT_1`, `MODULE_NOT_FOUND`), `"_"` if none.

A bucket groups all candidate-pool rows whose `signatureHash` matches.
Induction fires when a bucket has traces from **≥ N distinct episodes**
(configurable). Traces from the same episode do **not** count twice —
that prevents a single noisy run from minting a policy.

## 4. Similarity

`tracePolicySimilarity(trace, policy, embedder | null)` blends three
signals into a single score ∈ [0, 1]:

- **Cosine** (primary) between the trace's embedding (`vecSummary ??
  vecAction`) and the policy's vector `vec`.
- **Signature overlap bonus** of up to `+0.1`: a tiny nudge when the
  primary tag, tool, or error code match.
- **Hard gate**: if primary tags differ AND `errCode` is non-null on
  both sides AND they differ, the score is floored at `0` (prevents
  e.g. a `network|docker` trace matching a `python|venv` policy).

This keeps the math cheap (one cosine + a few string compares) while
respecting the "compatible context" constraint from V7 §2.4.1.

For candidate-pool deduplication we use plain cosine — signature check
already happens via the bucket key.

## 5. Gain

V7 §0.5.2 defines policy gain as "how much better does outcome look
when this policy is actually in play?". We implement it as:

```
gain = weightedMean(V | with-set)  −  shrinkBaseline(V | without-set)
```

where `weightedMean` is the softmax-weighted mean from V7 §0.6 eq. 3
(see `similarity.ts::valueWeightedMean`), and `shrinkBaseline` is a
Beta-binomial style blend of the empirical without-mean against a
neutral 0.5 prior (`gain.ts::V7_NEUTRAL_BASELINE`,
`WITHOUT_PRIOR_PSEUDOCOUNT = 5`):

```
shrinkBaseline(empirical, n) =
    (empirical · n  +  0.5 · 5)
  / (n  +  5)
```

Why the prior? In real interactive usage almost every episode succeeds
and reward backprop spreads similar V values across all step traces, so
`mean(V_without)` collapses onto `mean(V_with)` and the V7 contrast
formula evaluates to ≈ 0 for every policy regardless of its actual
utility. Anchoring the without-set against a neutral 0.5 baseline
guarantees that genuinely-useful policies (V_with ≈ 0.7-0.85) score
positive and net-neutral or harmful ones don't. As real comparable
without-evidence accumulates, the prior gracefully dilutes and we
recover the original V7 §0.6 contrast formulation.

Use cases:

- `withCount < 3` → fall back to arithmetic mean to avoid tiny-N
  softmax blow-ups on the with-set.
- `withoutCount == 0` → `shrinkBaseline` returns the prior (0.5);
  the policy is judged purely on whether its with-set lifts above
  neutral.

Status transitions (`gain.ts::nextStatus`):

| current     | condition                                              | next        |
|-------------|--------------------------------------------------------|-------------|
| `candidate` | `support ≥ minSupport` AND `gain ≥ minGain`            | `active`    |
| `active`    | `gain < retireGain`                                    | `retired`   |
| `retired`   | —                                                      | `retired`   |

All thresholds come from `algorithm.skill.*` (shared knobs across
L2 + Skill — see `docs/CONFIG-ADVANCED.md`).

## 6. Configuration (`algorithm.l2Induction.*`)

| Key                       | Default  | Meaning                                                   |
|---------------------------|----------|-----------------------------------------------------------|
| `minSimilarity`           | 0.65     | Cosine floor for trace→policy association.                |
| `candidateTtlDays`        | 30       | How long an unpromoted candidate stays in the pool.       |
| `minEpisodesForInduction` | 2        | Minimum distinct episodes to mint a new policy.           |
| `minTraceValue`           | 0.01     | Ignore traces whose V is below this after backprop.       |
| `useLlm`                  | true     | `false` → collect candidates but never call the prompt.   |
| `traceCharCap`            | 3000     | Chars per trace handed to `l2.induction`.                 |
| `archiveGain`             | -0.05    | Active policies dipping below this become `archived`.     |

Shared with `algorithm.reward.*`:
- `gamma`, `tauSoftmax` — used for value-weighted mean in `gain`.

## 7. Public API

```ts
import {
  runL2,                    // pure orchestrator
  attachL2Subscriber,       // reward.updated → runL2 bridge
  createL2EventBus,         // typed pub/sub
  signatureOf, bucketKeyOf, // utility: compute pattern signature
  tracePolicySimilarity,
  valueWeightedMean,
  computeGain, nextStatus,
  makeCandidatePool,
  type L2ProcessResult,
  type L2Event,
  type PatternSignature,
} from "@memtensor/memos-local-plugin/core/memory/l2";
```

## 8. Events (`L2EventBus`)

| Kind                     | When                                                            |
|--------------------------|-----------------------------------------------------------------|
| `l2.trace.associated`    | Trace matched an existing policy (cosine ≥ threshold).          |
| `l2.candidate.added`     | Trace added to / refreshed in `l2_candidate_pool`.              |
| `l2.policy.induced`      | New `candidate` policy minted from an induction bucket.         |
| `l2.policy.updated`      | `support`/`gain`/`status` recomputed & persisted for a policy.  |
| `l2.failed`              | Stage threw something non-recoverable (also logged at `error`). |

## 9. Persistence contract

| Row / table          | Fields written                                                           |
|----------------------|--------------------------------------------------------------------------|
| `policies` (insert)  | `id`, `title`, `trigger`, `procedure`, `verification`, `boundary`, `support=1`, `gain=draft.confidence`, `status='candidate'`, `source_episodes_json`, `induced_by`, `vec` |
| `policies` (update)  | `support`, `gain`, `status`, `updated_at`                                |
| `l2_candidate_pool`  | `id`, `policy_id=null`, `signature`, `evidence_trace_ids_json`, `similarity`, `expires_at` |
| `l2_candidate_pool`  | `policy_id` on promotion                                                  |

Audit: every `l2.policy.induced` + `l2.policy.updated` is logged at INFO
to channel `core.memory.l2`; the events bus payload is what the viewer
renders live. Nothing here is ever deleted by retention — `audit.log`,
`events.jsonl`, and `llm.log` are write-once sinks (see `docs/LOGGING.md`).

## 10. Tests

| Test                        | Covers                                                                |
|-----------------------------|-----------------------------------------------------------------------|
| `signature.test.ts`         | `signatureOf`, component parse/join, bucket key determinism           |
| `similarity.test.ts`        | Cosine gates, sig bonus, weighted mean, centroid edge cases           |
| `gain.test.ts`              | `computeGain` math, `nextStatus` transitions, `applyGain` persistence |
| `candidate-pool.test.ts`    | Insert / refresh / distinct-episode bucket gating / promote / prune   |
| `associate.test.ts`         | Match, no-match, traces w/o vec, retired policies ignored             |
| `induce.test.ts`            | Prompt success, malformed JSON, `useLlm=false`, builds policy row     |
| `events.test.ts`            | Pub/sub, error isolation, `onAny`, listenerCount                      |
| `subscriber.test.ts`        | `reward.updated` → `runL2`, detach, `runOnce`                         |
| `l2.integration.test.ts`    | 3-episode end-to-end: candidates → induction → association            |

Run: `npx vitest run tests/unit/memory/l2`.
