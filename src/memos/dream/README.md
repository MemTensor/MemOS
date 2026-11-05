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


## Opt-in lifecycle maintenance (PostgreSQL)

Dream retention is explicit and disabled by default. The initial atomic backend is
PostgreSQL with pgvector. Existing providers remain usable with lifecycle disabled;
enabling it on a backend without the capability raises an error. No schema, public
HTTP route, request model or new core dependency is required.

Supply lifecycle options in the component context before initializing the Dream
plugin (the ordinary server bootstrap owns this context):

```python
context["configs"]["dream_lifecycle"] = {
    "enabled": True,
    "policy": {
        "half_life_seconds": 604800,
        "never_hit_grace_seconds": 604800,
        "event_max_age_seconds": 86400,
        "receipt_capacity": 128,
    },
    "cube_ids": ["authorized-cube"],
    "checkpoint_directory": "/var/lib/memos/dream-cursors",
    "interval_seconds": 0,  # manual; positive enables a cooperative worker
    "limits": {"page_size": 100, "max_nodes": 10000, "max_seconds": 60},
}
plugin.init_components(context)
report = plugin.lifecycle.run_maintenance("authorized-cube", dry_run=True)
print(report.model_dump_json(indent=2))
```

Only explicitly registered cubes are visited, including quiet cubes with no new
Dream signals. Additional scopes require `plugin.lifecycle.register_cube(cube_id)`.
The caller authorizes those scopes; the runner does not enumerate tenants or add
permissions. Maintenance reads bounded metadata pages, revalidates under row locks
and never hard-deletes memories or changes stored content/embeddings/confidence.
It derives effective strength from fixed event-time anchors, not repeated decay.
Retrieval counts reinforce retention but do not constitute positive usefulness.

The decorated API search path records only final returned IDs after result pipes.
Native successful feedback updates notify exact affected source IDs: superseded
sources are invalidated; in-place corrections contribute a negative outcome without
invalidating corrected current content. General answer sentiment does not invalidate
all retrieved memories. Notifications use detached snapshots and fail open for the
original operation. `plugin.lifecycle.observer.delivery_snapshot()` exposes failed
delivery counters. These notifications are not a durable outbox or a transaction
with the search/feedback operation, and the SDK search path is not automatically
covered. Use explicit scoped events for SDK or application feedback:

```python
from datetime import datetime, timezone
from memos.dream.lifecycle import EventKind, LifecycleEvent

service = plugin.lifecycle.service
event = LifecycleEvent(
    event_id="stable-producer-event-42", memory_id="returned-memory-id",
    cube_id="authorized-cube", at=datetime.now(timezone.utc),
    kind=EventKind.POSITIVE,
)
service.observe([event], now=datetime.now(timezone.utc))
```

Retain the same event ID, timestamp and payload across retries. Identical replay is
a no-op within the accepted-event-age horizon; conflicting IDs, expired events and
live receipt-capacity exhaustion fail rather than silently losing deduplication.
Capacity is deliberately bounded. This is not unlimited exactly-once processing.
Policy fingerprints prevent silently reinterpreting existing evidence after a
configuration change. Malformed metadata is quarantined, not treated as low quality.

`service.inspect(ids, cube_id=..., now=...)` explains decisions without initializing
state or modifying receipts. `service.set_pinned` exempts passive archive decisions;
explicit invalidation still wins. `service.restore(memory_id, cube_id=..., reason=...,
now=...)` restores lifecycle-owned archives, requiring `override_invalidation=True`
for explicitly invalidated evidence. It does not reconstruct lost content.

A checkpoint records backend/scope/policy identity and last committed page decisions
with evidence revisions. Atomic replacement follows database commit; a crash in
between can replay a page safely. A failed page rolls back and retains its previous
cursor, reporting the bounded retry IDs. Reports cap detailed decisions and count
omissions, retaining aggregate reasons. Dry runs write neither lifecycle state nor
checkpoint/lock files. Time/cancellation limits are cooperative between pages, not
hard deadlines for arbitrary backend calls. Plugin shutdown unregisters owned hooks
and acknowledges outstanding work; a timed-out backend operation is not claimed
to have stopped.

For native tests, provide `MEMOS_TEST_PG_DSN` for a disposable PostgreSQL+pgvector
database and run `pytest tests/dream -q`. Each test owns/drops its own schema. With
no DSN, backend tests skip explicitly. Install the existing tree/scheduler extras
and the backend's documented psycopg2-binary requirement; no model calls are needed.
Synthetic retention/throughput tests validate mechanics, not real-agent QA gains.
