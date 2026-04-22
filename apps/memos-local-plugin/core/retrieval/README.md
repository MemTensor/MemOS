# `core/retrieval` — Tier-1 / Tier-2 / Tier-3 recall

This module turns a user turn (or tool call, sub-agent kickoff, decision
repair event) into an `InjectionPacket` — the canonical DTO that adapters
splice into their host prompt (`memos_context`).

It is **V7-§2.6 "Hierarchical Memory Retrieval"** materialised in code:

| Tier | Source table   | What it surfaces                                   |
|------|----------------|----------------------------------------------------|
| 1    | `skills`       | Matching crystallised Skills (`Skill η ≥ minEta`). |
| 2    | `traces`, rollup | High-value trace snippets + sub-task episode summaries. |
| 3    | `world_model`  | Environment topology / inference rules.            |

The pipeline is **pure reads** — no writes, no LLM calls. Events fire on a
private `RetrievalEventBus` so pipeline orchestrators (Phase 15) can
forward them to the viewer / audit log.

## Why three tiers?

V7 §1.3: _"Skill is abstract strategy that loses command-level detail;
execution-time failures need concrete trace recall; deep reasoning needs
world-model topology."_ The three tiers answer three different **questions**:

- **Tier 1 (task-level)** — "Do I have a named skill for this?"
- **Tier 2 (step-level)** — "Last time I tried this, what worked?"
- **Tier 3 (reasoning-level)** — "What environment am I actually operating in?"

## Five entry points

All five return a `RetrievalResult = { packet, stats }`:

```ts
import {
  turnStartRetrieve,     // onConversationTurn — full Tier 1+2+3
  toolDrivenRetrieve,    // memory_search / memory_timeline / …
  skillInvokeRetrieve,   // agent is about to call skill.<name>
  subAgentRetrieve,      // sub-agent spawned with mission prompt
  repairRetrieve,        // N tool failures → anti-pattern recall
} from "@memtensor/memos-local-plugin/core/retrieval";
```

Each entry selects which tiers to run, whether to allow low-priority
("anti-pattern") traces, and how many snippets to keep. See
`retrieve.ts` for the policy table.

## Query building

`buildQuery(ctx)` is the single source of truth for *what string* goes into
the embedder for each ctx shape. It also extracts coarse domain tags —
"docker", "pip", "plugin" — using the same keyword table as
`core/capture/tagger.ts`, so retrieval's tag filter matches traces that
capture actually tagged.

## Ranker

`rank()` does three things:

1. **Per-tier priority blend** — for Tier 2 traces and episodes:
   `relevance = weightCosine·cos + weightPriority·priorityFor(V, Δt)`.
   For Tier 1 skills we blend cosine with `η` (reliability).
2. **Cross-tier RRF fusion** — `score += 1 / (k + rank_i)` for every
   sub-list a candidate appears in. Classic Reciprocal Rank Fusion with
   `k = rrfConstant = 60`.
3. **MMR diversity pass** — greedy, `λ · relevance − (1-λ) · max_sim`.
   Before MMR we *seed* with one pick per non-empty tier so the final
   packet is never a single-tier monoculture.

## Tier-1 skill injection mode

V7 §2.6 says skills are "candidate strategies the model can choose from".
Inlining the full `invocationGuide` for every Tier-1 hit bloats the
prompt with content the agent may never use. We support two modes via
`algorithm.retrieval.skillInjectionMode`:

| Mode      | What lands in the prompt                                                   | When to use                                     |
|-----------|----------------------------------------------------------------------------|-------------------------------------------------|
| `summary` (default) | `name`, `η`, `status`, a 1-line summary, plus a `skill_get(id="…")` invocation hint. The footer also lists `skill_get` / `skill_list`. | Tool-calling hosts (OpenClaw, Hermes). Keeps prompts small; the agent calls `skill_get` only for skills it actually wants. |
| `full`    | Legacy: full `invocationGuide` body per skill (truncated to 640 chars).    | Hosts without function-calling support.         |

The summary text is the first paragraph of `invocationGuide` (clamped to
`skillSummaryChars`, default 200). Headings like `### Procedure` are
stripped before extraction so the summary reads as a description, not a
mid-rubric snippet.

## Multi-channel candidate gathering

Each tier issues **multiple candidate channels in parallel**, then folds
them via per-channel RRF in the ranker. Channels:

| Channel       | Backed by                                      | When it shines                                            |
|---------------|------------------------------------------------|-----------------------------------------------------------|
| `vec_summary` | `traces.vec_summary` cosine                    | Semantic recall on what the user/assistant said           |
| `vec_action`  | `traces.vec_action` cosine                     | Semantic recall on the agent's action / tool sequence      |
| `vec`         | `skills.vec`, `world_model.vec` cosine         | Tier-1 / Tier-3 semantic recall                            |
| `fts`         | FTS5 trigram MATCH (migration 010)             | Keyword-precise hits, English + CJK ≥ 3 chars              |
| `pattern`     | `LIKE %term%` (CJK bigrams + 2-char ASCII)     | 2-char Chinese names / verbs that fall below the trigram window |
| `structural`  | `instr(error_signatures_json, '"<frag>"')`     | Verbatim error-signature replay (V7 §2.6)                  |

A row that surfaces in multiple channels carries one `ChannelRank` per
match. The ranker sums `1 / (k + rank_i + 1)` across channels — so a
hit confirmed by both vector AND FTS gets a noticeably higher RRF than
either channel alone. This is what plugs the
"single-channel-false-positive" hole pure-cosine retrieval has.

## Adaptive relevance threshold + smart MMR seed

After the per-channel RRF pass, the ranker computes a **top relevance**
across the bag and drops every candidate below
`topRelevance · relativeThresholdFloor` (default `0.4`). This is an
adaptive cousin of an absolute `minTraceSim` floor — a strong query
(top relevance ≈ 0.9) trims to ≥ 0.36, a weak query (top ≈ 0.4) keeps
items down to ≥ 0.16.

MMR's Phase A seed picks **one candidate per non-empty tier** so packets
stay diverse. With the new `smartSeed` flag (default on), a tier is only
seeded if its best candidate clears the same relative threshold —
preventing the legacy "force-inject a stale Tier-1 skill / Tier-3
world-model just because the tier had something" failure mode.

## Trace pre-filter

Because a user's `traces` table can reach 10⁶+ rows, Tier 2 applies
two cheap reductions before vector search:

1. `anyOfTags` on `traces.tags_json` — domain tag pre-filter
   (`tagFilter: auto | strict | off`).
2. `vec_summary` / `vec_action` cosine — brute-force top-K over the
   reduced pool (`poolSize = tier2TopK · candidatePoolFactor`).

When `tagFilter: "auto"` and the tag-filtered pool is empty, retrieval
falls back to the un-tagged candidate pool once — so a mis-tagged query
never yields an empty packet for a user who has relevant traces with
different tags.

## LLM relevance filter — fail-closed

After the ranker hands us a list, an optional LLM round-trip
(`llm-filter.ts`) prunes items that share surface keywords with the
query but aren't actually useful. Two safety rails:

- **Few-shot prompt** with explicit `KEEP / DROP` examples + an explicit
  "drop, don't pad" instruction. Bumps `RETRIEVAL_FILTER_PROMPT.version`
  → audit trails attribute hits to the new prompt.
- **Fail-closed safe cutoff**: if the LLM call throws, the filter
  applies a tighter mechanical relevance cutoff (`0.7 · topScore`) +
  `llmFilterMaxKeep` cap, instead of dumping the entire ranked list
  into the prompt. Always keeps at least 1 item so the agent sees
  something.

## Files

```
core/retrieval/
├── types.ts          # DTOs (RetrievalDeps / RetrievalResult / Tier* shapes / ChannelRank)
├── query-builder.ts  # ctx → text + tags + ftsMatch + patternTerms
├── tier1-skill.ts    # Skill retrieval (vec + fts + pattern)
├── tier2-trace.ts    # Trace + episode-rollup (vec×2 + fts + pattern + structural)
├── tier3-world.ts    # World-model retrieval (vec + fts + pattern)
├── ranker.ts         # per-channel RRF + relative threshold + smart-seed MMR
├── llm-filter.ts     # post-ranker precision pass (fail-closed)
├── injector.ts       # RankedCandidate[] → InjectionPacket (+ rendered)
├── retrieve.ts       # 5 entry points (turnStart / toolDriven / …)
├── events.ts         # createRetrievalEventBus
├── index.ts          # public re-exports
├── README.md         # this file
└── ALGORITHMS.md     # V7 → code mapping
```

The keyword channel helpers (`prepareFtsMatch`, `extractPatternTerms`,
`reciprocalRankScore`) live in `core/storage/keyword.ts` next to the
FTS migration.

## Configuration

Every knob lives under `algorithm.retrieval.*` in `config.yaml`. The
user-facing config template only exposes `tier1TopK / tier2TopK /
tier3TopK`; everything else falls back to sensible defaults documented in
`docs/CONFIG-ADVANCED.md`.

## Public API

```ts
import {
  // Entry points
  turnStartRetrieve,
  toolDrivenRetrieve,
  skillInvokeRetrieve,
  subAgentRetrieve,
  repairRetrieve,
  // Class wrapper for OO consumers
  Retriever,
  // Events
  createRetrievalEventBus,
  type RetrievalEvent,
  // Types
  type RetrievalCtx,
  type RetrievalConfig,
  type RetrievalDeps,
  type RetrievalResult,
  type RetrievalStats,
} from "@memtensor/memos-local-plugin/core/retrieval";
```

## Events (`RetrievalEventBus`)

| Kind                | When                                                       |
|---------------------|------------------------------------------------------------|
| `retrieval.started` | Entry function called, about to embed query.               |
| `retrieval.done`    | `InjectionPacket` produced (even when empty).              |
| `retrieval.failed`  | Unexpected exception — packet falls back to empty.         |

Listeners are invoked synchronously on emit. Listener errors are caught
and logged (`core.retrieval.events.listener_threw`) so one bad subscriber
can't brick retrieval.

## Persistence contract

Retrieval **never writes**. The only state it touches:

- reads `skills`, `traces`, `world_model` via the repos;
- reads `RetrievalConfig` snapshot (provided by caller).

Even on failure nothing is rolled back / retried — the orchestrator is
expected to just accept an empty `InjectionPacket` and move on.

## Tests

- `tests/unit/retrieval/query-builder.test.ts` — ctx parsing + tag extraction.
- `tests/unit/retrieval/tier1.test.ts` — mocked skill repo.
- `tests/unit/retrieval/tier2.test.ts` — real SQLite + trace tag filter.
- `tests/unit/retrieval/tier3.test.ts` — real SQLite + world model.
- `tests/unit/retrieval/ranker.test.ts` — MMR + tier seeding edge cases.
- `tests/unit/retrieval/injector.test.ts` — snippet rendering + truncation.
- `tests/unit/retrieval/events.test.ts` — bus isolation.
- `tests/unit/retrieval/integration.test.ts` — end-to-end for all 5 entries.
- `tests/unit/capture/tagger.test.ts` — ensures capture-side tags align.
