# `core/memory/l3` — Algorithms

This note anchors the L3 implementation to the Reflect2Evolve V7 spec
(§1.1, §2.4.1, §4.3) and calls out the deviations we took for the
local-plugin runtime. Read alongside `README.md` for the high-level
contract.

---

## 1. Eligibility & gathering

**Input to `runL3`**: optional cluster hint; otherwise the orchestrator
scans all active L2 policies.

We only consider L2s that meet *all* of:

* `status = 'active'`  — candidates / retired policies never induce L3.
* `gain ≥ algorithm.l3Abstraction.minPolicyGain`.
* `support ≥ algorithm.l3Abstraction.minPolicySupport`.

The gain / support floors are deliberately low by default (`0.1` / `1`).
They exist to keep scratch-pad policies out of the world-model picture,
not as a primary gate — the primary gate is the LLM itself, which can
return `confidence = 0` and be filtered out.

---

## 2. Domain key extraction

```ts
domainKeyOf(policy) = primaryTag + "|" + secondaryTag
```

We derive tags via a stable, lowercase keyword sweep over
`procedure.preconditions`, `procedure.body`, and `trigger`:

```
docker|compose|kubernetes|k8s|alpine|ubuntu|debian
node|npm|pnpm|yarn|python|pip|poetry|conda
rust|cargo|go|java|maven|gradle|typescript|javascript
```

Matches are ordered by the first-hit position so the sweep is
deterministic, then we pick the top two distinct tokens. We deliberately
**do not** embed free-form LLM tags here — domain keys must be cheap
and stable enough to hash.

Policies with no recognised domain keyword fall into the bucket
`__generic|` and are still candidates for clustering by vector
similarity.

---

## 3. Clustering

Spec (§2.4.1) expects a clustering step on "compatible sub-problems".
We implement a **two-stage bucket-then-split** algorithm:

```
Stage 1 — bucket by domain key
    byKey: Map<string, PolicyWithMeta[]>

Stage 2 — centroid split inside each bucket
    center = centroid(vectors_in_bucket)         // null if no vecs
    for each member:
        if cosine(member.vec, center) ≥ θ_sim:    // config.clusterMinSimilarity
            kept.push(member)
        else:
            drop as outlier  // will be retried next run

    if |kept| ≥ θ_min:                            // config.minPolicies
        emit cluster(kept)
```

Rationale:

* Buckets give us **cheap, interpretable** groupings that match the way
  humans read the policies ("all the pip-on-alpine stuff").
* Centroid cutoff inside the bucket prevents two unrelated flavours of
  the same keyword (e.g. `python|pip` for data-sci vs `python|pip` for
  web-scraping) from being over-fused.

`avgGain` on each cluster is the mean `gain` of its surviving members.
It seeds ranking in the UI and can feed a future priority queue.

---

## 4. Evidence packing

Per cluster we assemble a prompt payload:

```
{
  primary_tag: string,
  domain_tags: string[],
  avg_gain: number,
  avg_support: number,
  policies: PolicyPrompt[],     // up to |cluster|, each capped
  evidence:  TracePrompt[]      // at most traceEvidencePerPolicy × |cluster|
}
```

* Each policy is serialised `id | title | trigger | procedure | rationale`
  truncated to `policyCharCap` characters.
* For each policy we fetch the most recent non-redacted supporting
  trace (by `episodeId`) and include up to `traceCharCap` characters of
  `userText + reflection`. Evidence is **read-only**, never mutated.
* Total token budget is bounded by `policyCharCap × |cluster| +
  traceCharCap × evidencePerPolicy × |cluster|`, which is deterministic
  and easy to debug.

---

## 5. LLM abstraction (`l3.abstraction` prompt)

Prompt id `l3.abstraction` (see `core/llm/prompts/l3-abstraction.ts`).
The system message makes three contracts explicit:

1. Output MUST be a JSON object. We wrap with `completeJson` so a
   parse failure is auto-retried once by the LLM adapter.
2. The keys `environment`, `inference`, `constraints` are required —
   each is an array of `{ label, description, evidenceIds[] }`.
3. `body` is a rendered markdown summary; `confidence ∈ [0, 1]`;
   `supersedes_world_ids` is optional.

`normaliseDraft` coerces any loose LLM output into a strict `L3AbstractionDraft`:

* Strips non-string evidence ids and non-object entries.
* Uses `title || "<generated>"` and `body || ""` so we never persist
  `undefined`.
* Clamps confidence into `[0, 1]`.
* Deduplicates `domain_tags` and lowercases them.

On LLM failure we return `{ ok: false, skippedReason }` — the cluster
is dropped for the current run, logged, and the cooldown is **not**
set, so the cluster will be retried next trigger.

---

## 6. Merge vs create

Given a cluster and its draft:

```
candidates = gatherMergeCandidates(cluster, draft)   // findByDomainTag + supersedes lookup
if draft.supersedesWorldIds contains an existing WM:
    return { kind: "update", target: explicit, cosine: 1 }
if cluster.centroidVec is null:
    return { kind: "create" }

best = argmax over candidates of cosine(centroidVec, wm.vec)
if best.cosine ≥ clusterMinSimilarity:
    return { kind: "update", target: best.row, cosine: best.cosine }
return { kind: "create" }
```

`mergeForUpdate` then unions the structured arrays:

```
patch.structure = {
    environment: dedupeByLabel(existing.environment ∪ draft.environment),
    inference:   dedupeByLabel(existing.inference   ∪ draft.inference),
    constraints: dedupeByLabel(existing.constraints ∪ draft.constraints),
}
patch.domainTags       = dedupe(existing.domainTags ∪ draft.domainTags)
patch.policyIds        = dedupe(existing.policyIds ∪ cluster.policyIds)
patch.sourceEpisodeIds = dedupe(existing.sourceEpisodeIds ∪ cluster.episodeIds)
patch.confidence       = clamp(existing.confidence + confidenceDelta, 0, 1)
patch.body             = draft.body  (LLM rewrite is authoritative)
patch.inducedBy        = "l3.merge"
```

Dedupe uses normalised labels (`trim().toLowerCase()`) so small
whitespace / casing differences fold in.

---

## 7. Confidence updates

Confidence is the single scalar Tier-3 retrieval and the viewer rank
on. It moves along three axes:

| Event                              | Delta                                  |
| ---------------------------------- | -------------------------------------- |
| New WM inserted                    | `clamp(draft.confidence, 0, 1)`        |
| Merge into existing WM             | `+algorithm.l3Abstraction.confidenceDelta` |
| Human thumbs-up                    | `+confidenceDelta`                     |
| Human thumbs-down                  | `−confidenceDelta`                     |
| LLM-driven supersedes              | target WM retains `existing.confidence + delta`; the superseded WM's `inducedBy` is marked `l3.superseded` |

All changes are logged on `core.memory.l3.confidence` (LLM driven) or
`core.memory.l3.feedback` (human driven) with `{ previous, next }` for
audit.

---

## 8. Cooldown

Runs are expensive (LLM-bound). We debounce per-cluster via the `kv`
table:

```
key = `l3.lastRun.${cluster.primaryTag}`
if (now − kv.get(key)) < cooldownDays × 86_400_000:
    skip cluster, emit l3.abstraction.started with skippedReason="cooldown"
```

`cooldownDays = 0` disables this entirely (used by tests).

---

## 9. Failure policy

* Storage error → propagate. Partial state remains; next run sees the
  same eligible policies and re-drives.
* LLM error → single-cluster skip, reason logged. No cooldown update.
  Other clusters continue.
* Invalid draft (missing `environment/inference/constraints`) →
  treated as LLM error.
* Subscriber throws on `l2.policy.induced` → bus catches and logs to
  `core.memory.l3.events.listener_threw`; never crashes L2.

---

## 10. Retrieval integration

Tier-3 retrieval (`core/retrieval/tier3.ts`) takes every L3 row with
`confidence ≥ minConfidenceForRetrieval` and ranks them by:

```
score(wm) = α · cosine(query, wm.vec) + β · wm.confidence
          − γ · staleness(wm.updatedAt)
```

See `core/retrieval/ALGORITHMS.md` for the ranking details. The L3
module itself does **not** know about retrieval; it only writes the
data that retrieval consumes.
