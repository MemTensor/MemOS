# `core/memory/l3` — L3 world model abstractor

Implements the **environment world model** layer of Reflect2Evolve V7
(§1.1, §2.4.1). While L2 captures "how to solve a recurring sub-problem",
L3 captures **the shape of the environment** that sub-problem lives in —
the shared facts, inference rules, and taboos that make a whole family
of L2 policies make sense.

Formally, V7 writes:

```
f^(3) = (ℰ, ℐ, C, {f^(2)})
```

* `ℰ` — **environment topology**. What lives where; how the environment
  is laid out. *e.g. "Alpine containers ship musl libc, not glibc"*.
* `ℐ` — **inference rules**. What the environment typically does in
  response to common actions. *e.g. "pip install binary wheel → ABI
  mismatch → falls back to compile"*.
* `C` — **constraints / taboos**. What you must not do here. *e.g.
  "don't commit node_modules"*.
* `{f^(2)}` — the set of L2 policies that cite this world model.

The L3 pipeline is deliberately **cross-task**. A single episode never
produces an L3 row; we wait until enough high-quality L2 policies exist
to generalise safely.

## Pipeline

```
l2.policy.induced  ── triggers ──▶  attachL3Subscriber
                                           │
                                           ▼
                                     runL3(input, deps)
                                           │
   1. gather eligible L2 (active, gain ≥ θ, support ≥ σ)
   2. cluster by (domainKey, centroid cosine ≥ similarity)
   3. cooldown check per primary domain tag
   4. for each cluster:
        a. pack policies + a small evidence trace slice
        b. `l3.abstraction` prompt → draft
        c. gather candidate WMs via findByDomainTag
        d. chooseMergeTarget(cluster, candidates, draft)
             ├── update: mergeForUpdate + updateBody + bump confidence
             └── create: buildWorldModelRow + insert
        e. record cooldown timestamp in kv
   5. emit events + return result
```

No single step blocks reward/L2. Any LLM failure is captured as a
`skippedReason`; the run always terminates cleanly.

## Key concepts

### Clustering

`clusterPolicies` (see [`cluster.ts`](./cluster.ts) and
[`ALGORITHMS.md`](./ALGORITHMS.md)) bucket-sorts policies by a compact
**domain key** derived from the policy's trigger/procedure text
(`docker|pip`, `node|npm`, …) and then splits each bucket by centroid
cosine, so policies in the same bucket that are still semantically far
apart (different sub-environments) end up in separate clusters.

### Merge vs create

Whenever a cluster's centroid cosine-matches an existing WM that shares
at least one domain tag above `clusterMinSimilarity`, we **update** the
existing row instead of minting a new one. Merging is the default to
avoid sprawling near-duplicate WMs. The draft's optional
`supersedesWorldIds` field overrides this: if the LLM says "this WM
replaces `wm_X`", we always update `wm_X`.

### Confidence

Each WM carries a `confidence ∈ [0, 1]`. It moves in three ways:

* Fresh insert → `confidence = draft.confidence` (from the prompt).
* Merge into an existing WM → `confidence += confidenceDelta`, clamped.
* User feedback via `adjustConfidence()` → `±confidenceDelta`, clamped.

Tier-3 retrieval uses `minConfidenceForRetrieval` to hide low-confidence
WMs from answers while still persisting them for inspection.

### Cooldown

`algorithm.l3Abstraction.cooldownDays` debounces abstraction per domain
tag; the last run timestamp is stored in the `kv` table under
`l3.lastRun.<primary-tag>`. Set to `0` to disable.

## Public API

```ts
import {
  attachL3Subscriber,
  runL3,
  adjustConfidence,
  createL3EventBus,
  type L3Config,
  type L3ProcessInput,
  type L3ProcessResult,
} from "@memtensor/memos-local-plugin/core/memory/l3";
```

* `runL3(input, deps)` — imperative entry point; also what the
  subscriber calls internally.
* `attachL3Subscriber(deps)` — wire L3 to the L2 event bus. Returns a
  handle with `runOnce(...)` and `adjustFeedback(...)`.
* `adjustConfidence(wmId, polarity, deps)` — update WM confidence from
  human feedback (thumbs up/down on a retrieved WM in the viewer).
* `createL3EventBus()` — typed bus L3 emits on.

## Events

Emitted by `runL3` / `adjustConfidence`:

| Kind                         | When                                                     |
| ---------------------------- | -------------------------------------------------------- |
| `l3.abstraction.started`     | After clustering, before LLM calls.                      |
| `l3.world-model.created`     | New WM inserted.                                         |
| `l3.world-model.updated`     | Existing WM updated via merge.                           |
| `l3.confidence.adjusted`     | Confidence moved, whether via merge or human feedback.   |
| `l3.failed`                  | A single cluster failed (no run-level throw).            |

## Persistence

* `world_model` — the L3 table. Columns added by migration `003`:
  `structure_json`, `domain_tags_json`, `confidence`,
  `source_episodes_json`, `induced_by`. See
  [`../../storage/repos/world_model.ts`](../../storage/repos/world_model.ts).
* `kv` — stores per-domain-tag cooldown timestamps keyed
  `l3.lastRun.<tag>`.

## Configuration

See `algorithm.l3Abstraction` in
[`docs/CONFIG-ADVANCED.md`](../../../docs/CONFIG-ADVANCED.md#algorithml3abstraction).

| Key                          | Default | Purpose                                       |
| ---------------------------- | ------- | --------------------------------------------- |
| `minPolicies`                | `3`     | Min compatible L2s to trigger abstraction.    |
| `minPolicyGain`              | `0.1`   | Eligible L2 gain floor.                       |
| `minPolicySupport`           | `1`     | Eligible L2 support floor.                    |
| `clusterMinSimilarity`       | `0.6`   | Cosine cutoff for clustering & merging.       |
| `policyCharCap`              | `800`   | Char cap per policy in the prompt.            |
| `traceCharCap`               | `500`   | Char cap per evidence trace in the prompt.    |
| `traceEvidencePerPolicy`     | `1`     | Evidence traces per policy in the prompt.    |
| `useLlm`                     | `true`  | Toggle the LLM abstractor off for tests.      |
| `cooldownDays`               | `1`     | Debounce per domain tag.                       |
| `confidenceDelta`            | `0.05`  | Confidence step per merge / feedback.         |
| `minConfidenceForRetrieval`  | `0.2`   | Tier-3 hide threshold.                        |

## Logging

All L3 work is logged on dedicated channels (see
[`docs/LOGGING.md`](../../../docs/LOGGING.md)):

* `core.memory.l3` — run lifecycle.
* `core.memory.l3.cluster` — cluster assembly.
* `core.memory.l3.abstract` — LLM draft + skipped reasons.
* `core.memory.l3.merge` — merge decisions.
* `core.memory.l3.confidence` — confidence bumps.
* `core.memory.l3.feedback` — human feedback-driven confidence changes.
* `core.memory.l3.events` — listener dispatch errors.

## Tests

* `tests/unit/memory/l3/cluster.test.ts` — domain key + clustering + filtering.
* `tests/unit/memory/l3/abstract.test.ts` — LLM happy path, disabled, failed, malformed.
* `tests/unit/memory/l3/merge.test.ts` — gather, pick, union-merge.
* `tests/unit/memory/l3/l3.integration.test.ts` — end-to-end against real SQLite:
  create, merge, LLM disabled, confidence adjustment.
* `tests/unit/memory/l3/subscriber.test.ts` — event-driven trigger + runOnce + feedback.
* `tests/unit/memory/l3/events.test.ts` — bus contract.

Run the whole L3 suite with `npm test -- tests/unit/memory/l3`.
