# Dream Plugin

**MemOS Dream** is a motive-driven, offline memory consolidation system — it forms internal motives first, recalls heterogeneous memories around those motives, and persists the results as both **dream diaries** (explainable traces) and **dream memories** (affecting future behavior).

> Without motives, it's batch summarization, not dreaming.
> Real dreams are driven by *"what's worth dreaming about"*, not *"what memories exist"*.

## Design Philosophy

Human dreams don't randomly compress the day's material. They revolve around:

- **Repeatedly activated** things
- **Unfinished** goals
- **Emotionally intense** events
- **Conflicting** information
- **Anticipated future needs**

Dream mirrors this: it starts from *unresolved internal motives*, not from a raw memory list.

## Narrative Scenario: Dreaming One Day Into One Strategy

This scenario explains why Dream is more than a nightly summary. During the day, the AI does not necessarily fail because each answer is wrong. It can fail because it treats one continuous user struggle as several unrelated tasks.

In this example, the user first asks for help preparing next week's weekly meeting, then discusses the future direction of an AI memory system, and finally asks for a concrete design for a filter module. The AI gives locally reasonable answers, but the user remains dissatisfied because the three topics need one shared strategic narrative.

Daytime chat input follows the codebase `MessageList` shape: each message is a dict with `role` and `content`.

```json
[
  {
    "role": "user",
    "content": "I need to present in next week's weekly meeting. Help me summarize this week's progress on Dream and the memory system."
  },
  {
    "role": "assistant",
    "content": "This week you completed retrieval experiments, filter interface changes, an initial Dream pipeline, user interviews, and evaluation preparation. Next week you can continue improving recall quality, metrics, and product validation."
  },
  {
    "role": "user",
    "content": "This sounds like a task list. I need it to have direction, not just a list of what happened."
  },
  {
    "role": "assistant",
    "content": "You can frame it as an OKR: the objective is improving long-term memory quality, with key results around retrieval quality, interface stability, Dream flow validation, and early user feedback."
  },
  {
    "role": "user",
    "content": "Still not right. Let's switch topics: where should this AI memory system go in the future? Stronger search, or an agent that actively understands people?"
  },
  {
    "role": "assistant",
    "content": "A practical roadmap is to improve search and recall in the short term, add personalization in the middle term, and evolve into a proactive assistant in the long term."
  },
  {
    "role": "user",
    "content": "That's too generic. Anyone could say that. It doesn't explain why this direction is necessary."
  },
  {
    "role": "assistant",
    "content": "You can describe the direction as moving from passive retrieval to proactive memory, where the system reminds users of important information at the right time."
  },
  {
    "role": "user",
    "content": "Now let's discuss a concrete design. The current project recalls many memories, but only a few are actually useful. I want to build a new filter module. How should it work?"
  },
  {
    "role": "assistant",
    "content": "You can combine relevance, importance, and recency scores, then add a reranker. The interface can support metadata constraints and a user feedback loop."
  },
  {
    "role": "user",
    "content": "These are all components. The design has no soul. I don't know how to convince people that it matters."
  }
]
```

The daytime failure is not caused by missing facts. It is caused by over-fragmented problem boundaries. The AI treats the weekly report as writing, the future plan as a roadmap, and the filter as an engineering module. It produces correct but shallow local answers. The real user need is different: how to turn this week's progress, the long-term direction, and the current module design into one coherent story.

At night, Dream does not need to replay every message. It focuses on repeated failure signals: "too scattered", "too generic", "like components", and "no direction". Dream can cluster those memories into one motive:

```json
{
  "motive_id": "motive:dream_memory_strategy_alignment",
  "description": "Several conversations failed for the same hidden reason: weekly reporting, future planning, and filter design were treated as separate tasks, while the user needed a shared strategic narrative.",
  "memory_ids": ["weekly_report_thread", "future_planning_thread", "filter_design_thread"]
}
```

In the dream, the AI sees three tables. On the first table is the weekly report, full of completed tasks but without a title. On the second is the future roadmap, long and ambitious but with no starting point. On the third is the filter architecture, full of valves, scores, and rerankers, but it is unclear whose pain this machine is meant to solve.

The AI first tries to patch each table separately: add a better title to the report, add a vision to the roadmap, add formulas to the filter. Each patch collapses because it still does not answer the same hidden question. Then one sentence appears in the dream:

> The user does not want an AI that searches better. The user wants an AI that knows what is worth remembering, when it should be recalled, and why it matters now.

The global conclusion after waking is:

> This week's work can be unified around the "memory selection layer". In the short term, it is a filter that selects truly useful memories from many candidates. In the middle term, it becomes a reflection mechanism that turns daytime failures, conflicts, and fragments into insights. In the long term, it is the starting point for moving AI from passive search toward active cognition.

With that conclusion, the AI can rewrite all three answers the next morning.

The weekly report becomes:

> The core finding this week is that the bottleneck of long-term memory is not only whether the system can recall more content, but whether it can judge which memories are truly important in the current context. Around this finding, we ran retrieval experiments, user interviews, filter interface updates, and the first Dream pipeline validation. Together, these efforts point to a new middle layer: the memory selection layer.

The future plan becomes:

> The future system should not only be searchable memory. It should become reflective memory. It should not only store the past, but continuously judge which experiences are becoming patterns, which failures deserve reflection, and which information should proactively surface later.

The filter design becomes:

> The filter is the smallest implementation of the memory selection layer. Version one uses relevance, importance, recency, and the current user goal for explainable selection. Version two adds user feedback to learn which memories were actually used. Version three connects to Dream, so fragmented daytime memories that were not understood in the moment can be reorganized into new insights at night.

In this example, Dream is not mystical inspiration. It is offline problem reframing. It treats the user's three dissatisfied reactions as one system signal: the user did not need isolated advice, but a cognitive throughline connecting reporting, strategy, and engineering design.

## Pipeline

```
 STEP 1             STEP 2              STEP 3               STEP 4
 Form Motives  ──►  Recall Around  ──►  Directed Dream  ──►  Persist
 (why dream?)       Motives             (consolidate)        (diary + memory)
                    (cross-type)
```

| Step | Stage Class | What It Does |
|------|-------------|--------------|
| 1 | `MotiveFormation` | LLM-powered: cluster pending memories into dream motives by identifying cross-conversation patterns, unresolved tensions, and repeated themes. Falls back to single-cluster heuristic without LLM. |
| 2 | `DirectRecall` | Use source-memory embeddings to recall related memories from `UserMemory` and `LongTermMemory` scopes. Results are deduplicated and ranked by similarity. |
| 3 | `ConsolidationReasoning` | LLM-powered deep dreaming: combine source and recalled memories, ask the LLM to reframe problems and produce concrete insights. Output: `DreamAction` (CREATE → `InsightMemory`) with hypothetical-deduction rationale. Falls back to placeholder without LLM. |
| 4a | `StructuredDiarySummary` | Package reasoning output into a human-readable diary entry (title, summary, dream content, motive context). Deterministic — no additional LLM call. |
| 4b | `DreamPersistence` | Execute DreamActions against `graph_db` (create/update/merge/archive across memory types) + persist diary. Fires `dream.before_persist` / `dream.after_persist` hooks. |

All four stages are fully implemented. Steps 1 and 3 are LLM-powered (each with dedicated prompts in `prompts/`); step 2 uses embedding-based similarity search; steps 4a and 4b are deterministic. When the LLM is unavailable, steps 1 and 3 fall back to simple heuristics. Each stage can be independently replaced — see [Contributing](#contributing).

## Triggering

```
add memory  ──►  on_add_signal  ──►  DreamSignalStore  ──►  threshold reached?
                                      (accumulate IDs)        ├─ yes → submit scheduler task → pipeline
                                                              └─ no  → keep accumulating
```

Manual trigger is also available via `POST /dream/trigger/cube`.

## Directory Structure

```
dream/
├── plugin.py          # Plugin entry point, wiring & registration
├── hooks.py           # Hook handlers (signal capture + execution orchestration)
├── hook_defs.py       # Plugin-scoped hooks (before/after persist)
├── maintenance.py     # Lifecycle maintenance (contribution entry point)
├── signal_store.py    # In-memory signal accumulator
├── types.py           # Data models (DreamAction, DreamResult, DreamMemoryLifecycle, etc.)
├── pipeline/
│   ├── base.py        # Pipeline orchestrator
│   ├── motive.py      # Stage 1 — motive formation
│   ├── recall.py      # Stage 2 — cross-type recall
│   ├── reasoning.py   # Stage 3 — consolidation reasoning (produces DreamActions)
│   ├── diary.py       # Stage 4a — diary generation
│   └── persistence.py # Stage 4b — memory write-back + diary persistence
├── prompts/
│   ├── motive_prompt.py      # Motive formation prompt
│   └── reasoning_prompt.py   # Consolidation reasoning prompt
└── routers/
    ├── trigger_router.py  # POST /dream/trigger/cube
    └── diary_router.py    # POST /dream/diary
```

## API

### Dream plugin endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/dream/trigger/cube` | Manually trigger a Dream run for a cube |
| POST | `/dream/diary` | Query diary entries with filter |
| GET | `/dream/diary/health` | Plugin status & scheduler connectivity |

### External endpoints that feed Dream signals

| Method | Endpoint | How it connects |
|--------|----------|-----------------|
| POST | `/add` | `@hookable("add")` → `add.after` hook → `on_add_signal` accumulates memory IDs |
| POST | `/chat/complete`, `/chat/stream` | Chat internally calls `handle_add_memories` → same `add.after` hook chain |

### Internal

| Component | How it connects |
|-----------|-----------------|
| `MemDreamMessageHandler` (scheduler) | Consumes dream tasks → `trigger_single_hook(H.DREAM_EXECUTE)` → pipeline |

### Query example

```json
POST /dream/diary
{
  "cube_id": "user_123",
  "filter": { "created_after": "2026-05-06", "limit": 5 }
}
```

## Persistence Design

### Two-track write

Dream persistence produces **two kinds of output**:

1. **Memory store write-back** — `DreamAction` mutations applied to the heterogeneous memory system:
   - `LongTermMemory` / `UserMemory`
   - `SkillMemory`
   - `ProfileMemory`
   - `PreferenceMemory`
   - `InsightMemory`

2. **Dream Diary** — an explainable trace stored in `graph_db` and queryable via the diary API.

### Persistence conditions

A `DreamAction` is only persisted when:

- **Hypothetical deduction passes**: the `rationale` field must demonstrate that a concrete question can be answered better with this memory. Empty rationale → action is skipped.
- **Confidence > 0**: the reasoning stage must assign non-zero confidence.

### Lifecycle maintenance

Each Dream-produced memory carries `DreamMemoryLifecycle` metadata (defined in `types.py`) and is designed for periodic maintenance. **The data model is in place but the maintenance logic is not yet implemented** — see `maintenance.py` for the contribution guide.

| Condition | Action |
|-----------|--------|
| Long time not hit (`last_hit_at` stale) | Decay / archive |
| Hit but low usefulness (`usefulness_score` below threshold) | Archive |
| Overturned by feedback (`invalidated_by_feedback = true`) | Immediate archive |

## Contributing

Each stage can be replaced independently:

| Want to improve… | Start here | Implement |
|------------------|------------|-----------|
| Motive detection — add signal sources beyond newness (conflict, frequency, feedback) | `motive.py`, `prompts/motive_prompt.py` | `form()` |
| Recall scope — extend beyond UserMemory / LongTermMemory | `recall.py` | `gather()` |
| Reasoning depth — multi-strategy or multi-action output | `reasoning.py`, `prompts/reasoning_prompt.py` | `reason()` |
| Diary narrative — LLM-generated prose instead of structured packaging | `diary.py` | `generate()` |
| Persistence logic — validation, conflict detection before write | `persistence.py` | `persist()` |
| Lifecycle maintenance (not yet implemented) | `maintenance.py` | `run_maintenance()` |
| Signal policies (dedup, decay, cooldown) | `signal_store.py` | `record_add()` / `should_trigger()` |
