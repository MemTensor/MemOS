# core/storage

Single source of truth for persistence in this project. Everything durable —
traces, policies, skills, world-model, episodes, feedback, audit events, the
L2 candidate pool, and housekeeping — lives in the SQLite database owned by
this module.

> **Engine:** `better-sqlite3` (synchronous, single-file, WAL-mode).
> **Why not async:** the whole core runs in one process; synchronous queries
> are simpler and faster for local workloads, and remove a whole class of
> race conditions.

## Layout

```
core/storage/
├── README.md              (this file)
├── types.ts               StorageDb / StorageStmt / filter types
├── connection.ts          openDb(): sets pragmas + transaction helper
├── migrator.ts            idempotent schema runner, discovers migrations/
├── tx.ts                  withRetry, buildInsert, buildUpdate, savepoints
├── vector.ts              float32 BLOB codec + cosine + brute top-K
├── migrations/
│   └── 001-initial.sql    full V7 schema (see docs/DATA-MODEL.md)
└── repos/
    ├── _helpers.ts        JSON / blob / page helpers
    ├── sessions.ts
    ├── episodes.ts
    ├── traces.ts          +vector search
    ├── policies.ts        +vector search
    ├── world_model.ts     +vector search
    ├── skills.ts          +vector search
    ├── feedback.ts
    ├── decision_repairs.ts
    ├── candidate_pool.ts
    ├── audit.ts
    ├── kv.ts
    ├── migrations.ts      read-only view of schema_migrations
    └── index.ts           makeRepos(db) → bundle
```

## Golden path

```ts
import { openDb, runMigrations, makeRepos } from "./core/storage/index.js";

const db = openDb({ filepath: "/Users/.../memos.db", agent: "openclaw" });
runMigrations(db);            // idempotent; cheap after first run
const repos = makeRepos(db);

repos.traces.insert({...});
const top = repos.traces.searchByVector(queryVec, 5);
```

Always call `db.close()` on shutdown. `core/pipeline/memory-core.ts` is the
one place that should open/close the handle in production.

## Pragmas we set

| Pragma                       | Reason                                                  |
|------------------------------|---------------------------------------------------------|
| `journal_mode = WAL`         | Allows concurrent readers (viewer) while daemon writes. |
| `synchronous = NORMAL`       | Good WAL trade-off; bumping to FULL costs ~2× writes.   |
| `foreign_keys = ON`          | Enforce referential integrity.                          |
| `temp_store = MEMORY`        | Avoid tmpfile churn for CTEs.                           |
| `busy_timeout = 5000`        | Survive the occasional cross-process lock contention.   |
| `wal_autocheckpoint = 1000`  | Keep the WAL bounded on long-running daemons.           |

## Transactions

Two shapes:

```ts
// Simple: whole function is one transaction. Rolls back on throw.
db.tx(() => { repos.traces.insert(a); repos.traces.insert(b); });

// Nested: partial rollback inside a larger tx.
withSavepoint(db, "try_one_thing", () => { ... });
```

Inside a transaction, don't sprinkle more `db.tx(...)` calls — better-sqlite3
maps outer `tx` to `BEGIN IMMEDIATE` and re-entry will throw.

## Vector search

All vector-bearing tables store a `vec` (or `vec_summary` / `vec_action`)
BLOB column holding little-endian `Float32Array` bytes. Encoding is handled
by `vector.ts#encodeVector` / `decodeVector`; nothing else should read those
blobs directly.

Brute-force cosine top-K is implemented in JS. At our target scale (<100k
vectors per table) this runs in tens of milliseconds on a laptop. When we
cross that threshold this module is the only thing that has to change.

## Migrations

- Every schema change lives in `migrations/NNN-<slug>.sql`.
- Filenames must match `^(\\d{3})-([a-z0-9][a-z0-9-]*)\\.sql$`.
- Migrations are **additive only**. Drops / renames require a major-version
  bump.
- Applied versions are recorded in `schema_migrations(version, name,
  applied_at)`. `runMigrations` is idempotent and safe to call on every
  daemon start.
- See `docs/DATA-MODEL.md` for the full column list.

## Observability

- Channel `storage` — open/close, pragmas.
- Channel `storage.migration` — migration lifecycle.
- Channel `storage.repos` — data-level events worth seeing in the viewer
  (e.g. bulk upsert warnings).
- Channel `storage.vector` — dimension mismatches, top-K timing.

## Testing

Tests use `tests/helpers/tmp-db.ts` to spin up a throwaway DB in a temp
directory. Every repo has a focused unit test under `tests/unit/storage/`.
Full integration ("open → migrate → write → read → close") is covered by
`tests/unit/storage/end-to-end.test.ts`.
