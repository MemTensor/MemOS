# Dream Plugin

Dream is an optional MemOS community feature, currently in beta. It explores how
an agent can reflect on recently added memories outside the foreground request
path, then consolidate them into higher-level context, insights, and diary
entries. The implementation is intentionally lightweight and extensible, and we
welcome the community to help improve the signal policy, prompts, persistence,
diary experience, and downstream integrations.

## Status and Enablement

Dream is disabled by default.

With no plugin environment variables configured, MemOS loads ordinary plugins as
before, but it does not load the built-in `dream` plugin. Enable it explicitly:

```bash
MEMOS_ENABLED_PLUGINS=dream
```

`MEMOS_DISABLED_PLUGINS` has the highest priority, so this keeps Dream disabled:

```bash
MEMOS_ENABLED_PLUGINS=dream
MEMOS_DISABLED_PLUGINS=dream
```

## Current Capabilities

When enabled, the built-in `CommunityDreamPlugin` provides:

- signal capture from successful memory add operations;
- deterministic Dream metadata enrichment during fine extraction;
- scheduler-driven Dream execution through the `dream.execute` hook;
- manual cube-level triggering through `POST /dream/trigger/cube`;
- Dream diary querying through `POST /dream/diary`;
- `Context` recall merged into normal search results.

The default pipeline is:

1. Build or update `Context` nodes from pending memories.
2. Form Dream motives from recently added source memories.
3. Recall related `UserMemory` and `LongTermMemory` nodes.
4. Use the configured LLM to produce at most one insight per motive.
5. Generate a human-readable Dream diary entry.
6. Persist valid insight actions and diary entries to the graph database.

If no LLM is available, Dream can still run the pipeline, but fallback reasoning
does not write new insight memories because zero-confidence actions are skipped.

## Usage

Enable Dream and start the API service:

```bash
export MEMOS_ENABLED_PLUGINS=dream
make serve
```

Check plugin health:

```bash
curl http://127.0.0.1:8000/dream/diary/health
```

Manually submit a cube-level Dream task:

```bash
curl -X POST "http://127.0.0.1:8000/dream/trigger/cube?cube_id=<cube_id>&user_id=<user_id>&user_name=<user_name>"
```

Query recent Dream diary entries:

```bash
curl -X POST http://127.0.0.1:8000/dream/diary \
  -H "Content-Type: application/json" \
  -d '{"cube_id": "<cube_id>", "filter": {"limit": 5}}'
```

Fetch one diary entry:

```bash
curl -X POST http://127.0.0.1:8000/dream/diary \
  -H "Content-Type: application/json" \
  -d '{"cube_id": "<cube_id>", "filter": {"task_id": "dream_diary_xxx"}}'
```

## Configuration

Plugin loading:

- `MEMOS_ENABLED_PLUGINS=dream`: enable Dream.
- `MEMOS_DISABLED_PLUGINS=dream`: disable Dream, even if it is also enabled.

Dream-specific options:

- `MEMOS_DREAM_HEURISTIC_ENRICHER`: defaults to `on`.
- `MEMOS_DREAM_ENRICH_OVERWRITE`: defaults to `off`.
- `MEMOS_DREAM_CONTEXT_ENABLED`: defaults to `on`.
- `MEMOS_DREAM_CONTEXT_SUMMARY_LLM`: defaults to `on`.
- `MEMOS_DREAM_CONTEXT_BINDING_LLM`: defaults to `on`.
- `MEMOS_DREAM_CONTEXT_BINDING_MIN_GROUP_SIZE`: defaults to `2`.
- `MEMOS_DREAM_CONTEXT_BINDING_MAX_GROUP_SIZE`: defaults to `30`.
- `MEMOS_DREAM_CONTEXT_BINDING_CONFIDENCE_THRESHOLD`: defaults to `0.65`.

## Beta Limitations

- Signals are stored in memory and do not survive process restarts.
- The automatic trigger policy is currently a simple pending-memory threshold.
- The built-in signal source focuses on new-memory accumulation. Conflict,
  feedback, frequency, and fragmentation signals are extension points.
- The diary and surfacing experience is still early.
- Write-back policies for update, merge, archive, and long-term maintenance are
  available as extension directions, not complete product behavior.

## Contributing

Dream is designed as a community-building surface. Good places to contribute:

- better trigger policies and signal stores;
- stronger motive formation and recall strategies;
- safer and more useful reasoning prompts;
- richer diary generation and user-facing surfacing;
- memory lifecycle and maintenance policies;
- alternative `dream` plugin implementations with higher priority.

Projects can ship their own plugin with the same logical name (`dream`). When
multiple providers expose `dream`, the plugin manager keeps the implementation
with the highest priority.
