# `core/retrieval` — Algorithms

Maps V7 retrieval prose to concrete code. References cite the headings /
equations in `apps/memos-local-openclaw/算法设计_Reflect2Skill_V7_核心详解.md`.

## 1 Priority formula — V7 §0.6 & §3.3

> `priority(f¹) ∝ max(V, 0) · decay(Δt)`

Implemented in `core/reward/backprop.priorityFor`:

```ts
decay(Δt) = 0.5^(Δtₐ / halfLife)   // Δtₐ in days; halfLife = 30 by default
priority  = max(V, 0) · decay(Δt)
```

We **re-derive** priority at retrieval time (Tier-2 `blendScore`) rather
than trusting the persisted value: that way a trace with fresh V but an
old write timestamp sinks naturally as time passes, even without a reward
rerun.

## 2 Tier-2 blended ordering — V7 §2.4.5

V7 says:

> "Tier 2 检索返回的相似 trace 按 V 降序排列"

We relax this to a **weighted blend of cosine and priority**:

```
score = weightCosine · cos + weightPriority · priorityForLive
```

With defaults `(0.6, 0.4)` the retrieved list is *primarily* the
closest-to-query traces, *tie-broken and re-weighted* by V·decay — so a
slightly-less-similar but clearly successful past attempt beats a nearly
identical but failed one.

Disabling priority entirely (`weightPriority = 0`) degenerates to pure
cosine, which matches the naive "similar first" baseline.

## 3 Cross-tier fusion — classic RRF

```
RRF(d) = Σᵢ 1 / (k + rankᵢ(d))
```

`k = rrfConstant = 60` is Lin & Oakes' commonly-used constant. Each tier
emits its own sub-list and RRF is evaluated independently, so we don't
need to rescale the (0, 1) cosine scores to match the (-∞, ∞) V·decay
range.

## 4 MMR diversity — Carbonell & Goldstein 1998

After RRF gives us a fused ranking, we pick **greedy**:

```
pick = argmax λ · rel(d) − (1-λ) · max_sim(d, selected)
```

with `λ = mmrLambda = 0.7` (relevance-leaning). Redundancy is `max
cosine` between the candidate's embedding and every already-selected
embedding. Candidates without a vec fall back to no-redundancy (0).

### Tier seeding

Before MMR loops we **seed** with one pick per non-empty tier (Tier 1 →
Tier 2 → Tier 3 order). This prevents "tier starvation" — if the query is
ambiguous and Tier 2's vector space dominates, Tier 1 and 3 would
otherwise never get a slot. Seeding adds at most 3 snippets of budget
overhead, which is well within typical `limit` values (≥ 5).

## 5 Tag filter — V7 §2.6

> "每条 trace 带有自动标注的领域标签 (如 docker / pip / plugin)，
>  先按标签缩小候选集，再做语义匹配"

Traces carry a `tags_json` column (see `core/storage/migrations/002-trace-tags.sql`).
Tags are derived *cheaply* in `core/capture/tagger.ts`:

1. Tool names → first path segment (`docker.run` → "docker").
2. Error codes → lowercase splits ("`NETWORK_REFUSED`" → "network", "refused").
3. A tiny keyword dictionary on the user/agent text (docker / kubernetes / pip / etc.).

At retrieval time `query-builder.extractTags` runs the **same** dictionary
on the compiled query. The resulting tags feed into
`traces.searchByVector(..., { anyOfTags })`, which does an `instr()` on
the JSON blob. This is an `O(N)` scan but short-circuited by SQLite's
execution plan and bounded by `hardCap = poolSize · 4`.

### Fallback — "auto" mode

With `tagFilter: "auto"` we retry once **without tags** if the tag-filtered
pool is empty. That way a mis-tagged query can never suppress an entire
retrieval. Strict mode (`"strict"`) skips the fallback; `"off"` never
sends tags to storage.

## 6 Episode rollups — V7 §2.6 "sub-task episode replay"

Tier 2 returns single-trace hits *and* episode-level summaries:

1. Bucket the candidate traces by `episode_id`.
2. For any bucket with ≥ 2 traces, emit an `EpisodeCandidate`:
   - `summary` = "episode N steps · best V=x\n· reflection: …\n· user: …"
   - `maxValue` = max of member traces
   - `meanPriority` = mean of member priorities
3. Sort episode rollups by `(maxValue, cosine)` desc, keep top `tier2TopK`.

Single-trace hits are left alone; adapters can choose whether to show
them directly or skip them in favour of the episode rollup.

## 7 Decision-repair path

`repairRetrieve` is the only entry that:

- sets `includeLowValue = true` (so anti-patterns with `priority=0`
  become visible), and
- feeds the failing tool name + error code directly into
  `query-builder` (not the user turn text).

This is how "N failures → unblock" works in practice: the query vector
drifts toward the *failure mode*, and low-V traces are allowed through
so the agent sees "last time this error showed up we tried X and it
failed too — try Y instead".

Returns **null** when:

- `failureCount === 0` (caller hasn't reached the threshold), or
- the pipeline produces an empty packet even with low-value enabled.

Callers treat `null` as "don't inject anything".

## 8 Deliberate deviations from V7 prose

1. **Skill status gating** — V7 doesn't specify which statuses count;
   we hide `retired` (audit-only) but keep `probationary` + `active` so
   fresh skills can still be surfaced with a reduced `minSkillEta`.
2. **World-model matching via embedding, not keyword** — V7 §2.6 talks
   about "extract domain keywords from ρ_t". Our world models are small
   enough (dozens of rows) that a cosine scan is cheaper and avoids
   maintaining a separate keyword → model table.
3. **Relevance formula blends η, not cosine-only, for skills** — gives
   reliable skills a natural lift over newly-minted ones with identical
   similarity.
4. **Static RRF / MMR constants** — not in V7 but needed to avoid
   degenerate packets. Values are user-tunable via `algorithm.retrieval.*`.
5. **Tier-1 summary mode** — V7 §2.6 implies the full Skill body is
   injected at turn start. We default to a *summary* representation
   (`name + η + 1-line description + a `skill_get(id="…")` invocation
   hint`) so the host model can pull the full procedure on demand
   instead of bloating every prompt with skills it may never use. Hosts
   without function calling can opt back into full-body inlining by
   setting `algorithm.retrieval.skillInjectionMode: "full"`. See
   `injector.ts::renderSkill` and `core/retrieval/README.md` for the
   exact rendering.
6. **Multi-channel candidate gathering** — V7 §2.6 prescribes a single
   cosine + structural-match path. Pure cosine over-matches on
   topic-level surface similarity ("any Python query recalls every
   Python trace"), so we add two keyword channels — FTS5 trigram MATCH
   and a `LIKE %term%` pattern fallback for queries below the trigram
   window (2-char Chinese, etc.) — and let the ranker fuse all
   channels via per-channel RRF (`assignChannelRrf` in `ranker.ts`).
   Multi-channel matches get a strong lift; single-channel surface
   hits no longer dominate. Full algorithm derivation in
   `core/retrieval/README.md` § "Multi-channel candidate gathering".
7. **Adaptive relative threshold + smart MMR seed** — V7's
   `priority(f¹) ∝ max(V,0) · decay(Δt)` only floors absolute value;
   we additionally drop candidates whose `relevance < topRelevance ·
   relativeThresholdFloor` (default 0.4). MMR's per-tier seed (Phase
   A) only fires for tiers whose best candidate clears that adaptive
   floor — no more force-injecting an irrelevant Tier-1 / Tier-3 just
   because the tier had a candidate. See `ranker.ts::rank` Phase 2 +
   Phase A.
8. **Tier-1 η downweight** — original blend was `0.6·cos + 0.4·η`
   which let high-η stale skills outrank fresh, query-aligned ones.
   New default `skillEtaBlend: 0.15` keeps the η reliability nudge
   but lets cosine dominate. Knob in `algorithm.retrieval`.
9. **LLM filter — fail-closed** — V7 doesn't model the post-ranker
   precision pass. Our `llm-filter.ts` runs a small LLM call with a
   few-shot prompt; on ANY failure (network, timeout, malformed JSON)
   we apply a tighter mechanical cutoff
   (`0.7 · topScore · llmFilterMaxKeep`) instead of dumping the whole
   ranked list into the prompt. Outcome `llm_failed_safe_cutoff`
   surfaces in the Logs page so operators can spot flaky LLMs.

## 9 Complexity bounds

- Tier 1/2/3 vector search: `O(poolSize · dim)` in CPU, `O(poolSize)`
  rows fetched from SQLite. `poolSize = tierTopK · candidatePoolFactor`.
- Episode rollup: `O(tier2Traces)` — single pass over the candidate list.
- RRF: `O(bag.size²)` (one `findIndex` per candidate per sub-list).
- MMR: `O(limit · bag.size)`.

For default settings (`tier*TopK = {3, 5, 2}`, `poolFactor = 4`) the
per-call budget is ≤ ~60 candidate rows, well under a millisecond of
ranker wall time on a laptop.
