# `core/memory/l2` — Algorithms

Maps V7 L2 prose to concrete code. Section / equation references cite
`apps/memos-local-openclaw/算法设计_Reflect2Skill_V7_核心详解.md`.

## 1 Pattern signature — §2.4.1 "跨任务 L2 诱导"

V7 defines a "pattern" as the distinctive observable + action +
side-effect fingerprint of a recurring sub-problem. We represent it as
a **deterministic string**:

```
sig(f¹) = <primaryTag> "|" <secondaryTag> "|" <tool> "|" <errCode>
```

The four slots are picked to be:

1. **Stable** across semantically similar traces (same tag/tool/err
   shows up across different conversations).
2. **Cheap** to compute (no LLM, no embedding): pure string extraction
   from tags, tool calls, and error messages.
3. **Collision-resistant enough** for bucket keys. We additionally hash
   the string to 16-hex for the candidate-pool primary key (see
   `candidate-pool.ts::signatureHash`) — collisions on 64-bit hashes are
   negligible for the pool sizes we operate at (O(10³)).

`_` fills any empty slot — a trace with only one tag still has a valid
signature (`docker|_|pip.install|_`).

## 2 Trace-policy similarity — §2.4.1 "兼容性约束"

```
score = clamp01(
  cosine(vec(trace), vec(policy))
  + sigBonus(sig(trace), sig(policy))
)
```

- `cosine` is the dot product of L2-normalised embedding vectors.
  We pick `trace.vecSummary ?? trace.vecAction` for the trace side,
  `policy.vec` for the policy side.
- `sigBonus ∈ [0, +0.1]`:
  - +0.05 if `primaryTag` matches (both non-`_`).
  - +0.03 if `tool` matches.
  - +0.02 if `errCode` matches.
- **Hard gate** ("兼容性约束"): if both sides have non-`_` `primaryTag`
  AND they differ, OR both sides have non-`_` `errCode` AND they
  differ → return `score = 0`. Prevents e.g. a `python|ruff` trace
  matching a `docker|apk` policy no matter how close the cosine.

Rationale: V7 argues that **retrieval cost grows faster than retrieval
value** when policies get imported across incompatible domains, so we
pay a small precision cost up front instead of letting the ranker
"reason through" every mismatched analogy.

## 3 Candidate pool — §2.4.1 "延迟决策"

V7 explicitly warns against **per-episode** policy induction ("a single
episode is not enough evidence"). We enforce that structurally:

- **Row key**: `hash(sig)` + `traceId`. Same trace re-seen refreshes
  TTL; different traces pile up independently even if they share a
  signature.
- **Bucket = signatureHash**. We only induce when a bucket has
  `≥ minEpisodesForInduction` **distinct episodes** (not traces). This
  is the critical property that prevents a flaky single-episode loop
  from minting a policy.
- **TTL**: `candidateTtlDays` (30 by default). A bucket that never
  reaches quorum drops out silently — `prune(now)` deletes expired rows.
- **Promotion**: when an induction succeeds or a dedup match fires, we
  fill `policy_id` on every row in the bucket and stop scanning that
  bucket.

Complexity: bucket scan is a single indexed SQL query
(`SELECT … GROUP BY signature`), so the whole pool step stays O(rows
matching signature) + one write per candidate.

## 4 Induction — §2.4.1 "LLM 归纳" + prompt `l2.induction`

Given a ready bucket:

1. **Cheap dedup pass**. For every candidate trace, ask the policy
   vector index for the top-5 nearest `active`/`candidate` policies and
   score via `tracePolicySimilarity`. If any score ≥ `minSimilarity`,
   we **skip the LLM call** and promote pool rows onto the existing
   policy. This is the single biggest LLM-cost lever in the whole
   pipeline.
2. **Pick one trace per episode** — the highest-V trace from each
   episode that fed the bucket. V7 wants **diverse, successful**
   evidence, not a "greatest hits" bag.
3. **Prompt**: `l2.induction`. Inputs: signature label, N episode
   summaries (`≤ traceCharCap` chars each). Output schema is validated
   at parse time (`validate`) — we require at minimum a `procedure`
   string; anything else falls back to defaults.
4. **Build policy row**. `vec = centroid(embedding vectors of the
   evidence traces)`. `gain = draft.confidence`. `support = 1` (will
   be recomputed in step 4 of the pipeline with real
   `with`/`without` partitioning). `status = "candidate"`.

## 5 Gain — §0.5.2 + §0.6 eq. 3

Let `S_with = {V(f¹) | this policy was associated with f¹}` and
`S_without = {V(f¹) | same episode, different trace}`.

```
gain(policy) = μ_weighted(S_with) − μ_arith(S_without)
```

Where `μ_weighted` is the V7 §0.6 softmax-weighted mean:

```
μ_weighted(V) = Σ w_i · V_i,          w_i = exp(V_i / τ) / Σⱼ exp(V_j / τ)
```

`τ = config.tauSoftmax` (shared with reward). τ→0 concentrates weight
on the best trace; τ→∞ degenerates to arithmetic mean.

Edge cases:

- `|S_with| < 3` → use arithmetic mean (softmax is too sensitive for
  tiny samples).
- `|S_without| = 0` → treat `μ_without = 0`. The policy has only
  positive evidence so far.

## 6 Status transitions — §2.4.1 lifecycle

```
if currentStatus == "candidate" && support ≥ minSupport && gain ≥ minGain:
    return "active"            # the policy has paid for itself

if currentStatus == "active" && gain < retireGain:
    return "retired"           # net harmful across recent uses

# otherwise hold current status
```

`minSupport`, `minGain`, `retireGain` live under `algorithm.skill.*`
(they're shared knobs for L2 + Skill lifecycles; see
`docs/CONFIG-ADVANCED.md`). Retired policies are **not deleted** — they
stay queryable by id for audit/what-if analysis, just excluded from
`searchByVector` and retrieval.

## 7 Reflection weights — §0.6 eq. 4/5 (inherited)

L2 consumes `V_t` and `α_t` that the reward pipeline has already
written onto each trace. L2 does **not** re-run backprop. This
separation is important: it means L2 is purely a *policy extraction*
layer over already-decided-upon credit assignment — we can rebuild L2
from a sqlite snapshot without needing the original LLM rubric.

## 8 End-to-end complexity (one episode)

Let `n = eligible traces`, `p = policies in DB`, `k = retrieval top-k`.

| Stage          | Cost                                                           |
|----------------|----------------------------------------------------------------|
| Associate      | O(n · (cosine topK over p) + n · k string compares)            |
| Candidate pool | O(n) inserts + one grouped scan                                |
| Induction      | O(bucket count × 1 LLM call); buckets ≪ n in practice          |
| Gain           | O(touched policies × n) — touched ≤ distinct matched policies  |

Even at n=50, p=200 the hot path is ~50 cosine-topK queries plus
zero-to-few LLM calls, so P95 is dominated by the induction prompt.
When `useLlm = false` the whole pipeline stays under ~5 ms on our
reference hardware.
