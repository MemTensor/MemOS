# openGauss graph storage

Select `GRAPH_DB_BACKEND=opengauss` and set `OPENGAUSS_HOST`, `OPENGAUSS_USER`, `OPENGAUSS_PASSWORD`, and `OPENGAUSS_DB`. Install the `tree-mem` extra. The target database must already have the required AGE and DataVec/BM25 capabilities; the adapter does not create a physical database.

Optional settings are `OPENGAUSS_PORT` (5432), `OPENGAUSS_MIN_CONN` (1), `OPENGAUSS_MAX_CONN` (20), `OPENGAUSS_CONNECT_TIMEOUT` (10 seconds), `OPENGAUSS_CONNECTION_WAIT_TIMEOUT` (30 seconds), and `EMBEDDING_DIMENSION` (1024). Explicit request Cube IDs take precedence over the configured default scope. A scope selection is a query filter, not an authorization grant.

## Dashboard ranges

`POST /product/get_memory_dashboard` accepts two optional, nullable fields. Existing clients can omit both.

| Field | Meaning |
| --- | --- |
| `all_cubes: null` or omitted | Preserve existing selection rules: a supplied `mem_cube_id` selects that Cube; otherwise openGauss selects all Cubes. |
| `all_cubes: true` | Select all Cubes. Cannot be combined with an outer `mem_cube_id` or a `public` single-Cube selection. |
| `all_cubes: false` | Select the supplied Cube, or the configured default if none is supplied. |
| `exclude_cube_id` | Exclude exactly one Cube from an all-Cube selection. Must be a nonblank string; an absent Cube excludes nothing. |

For example, list all scopes except `public`, with pagination:

```json
{
  "all_cubes": true,
  "exclude_cube_id": "public",
  "page": 1,
  "page_size": 20
}
```

The existing filter controls `{"object_type":"public","mem_cube_id":"P"}` select P, while `{"object_type":"user","mem_cube_id":"P"}` select all other Cubes. Controls are extracted from nested `and`/`or` trees and applied globally; remaining business predicates retain their Boolean structure. Repeated identical controls are accepted. Incomplete or conflicting controls, unknown object types, empty Boolean nodes, single-Cube exclusion, and conflicting exclusion IDs return parameter errors. Explicit `all_cubes=false` conflicts with a `user` selection.

`user_id`, memory type, status and business filters still constrain the selected range. Supply both positive `page` and `page_size`, or omit both to return all matching records. Pagination and totals apply independently to each of the four memory categories. A bucket's `total_nodes` counts its records on the current page; `statistics` counts all matching records before pagination.

All backends now return empty category lists when the page has no records, including explicitly selected Cubes. No empty Cube bucket is manufactured. An empty page can still have a positive total. A genuinely empty response has this shape:

```json
{
  "code": 200,
  "message": "Memories retrieved successfully",
  "data": {
    "text_mem": [], "tool_mem": [], "skill_mem": [], "pref_mem": [],
    "statistics": {
      "total_text_nodes": 0, "total_tool_nodes": 0,
      "total_skill_nodes": 0, "total_preference_nodes": 0
    }
  }
}
```

Only openGauss currently accepts non-null new range fields. Other adapters preserve their existing range rules for omitted/null fields and reject explicit new selections. `all_cubes` accepts JSON booleans, not `0`, `1`, or strings. Java clients adopting the fields should use nullable `Boolean`/`String`; do not replace an omitted choice with a primitive Boolean's default `false`.

Expect HTTP 422 for request-model type/shape errors, 400 for invalid range/filter combinations, and 500 for storage execution failures. An error response has `data: null`; callers must not interpret it as an empty successful query. The ordinary `/get_memory` request still requires `mem_cube_id` and does not gain these range fields.

## Resource ownership and current boundaries

Direct `TreeTextMemory` and `GeneralMemCube` instances close their own resources through `close()`. Injected graphs and memories remain borrowed. The API closes its shared graph after its Scheduler has finished using it; independently initialized Schedulers close their own graph. `Scheduler.stop()` stops work, while `close()` ends the lifecycle. Final close rejects new work and lazy initialization, waits for running tasks and recovery, reports cleanup failures, and can retry incomplete cleanup. Successful repeated close is a no-op.

Graph adapters without an explicit `close` are skipped for compatibility; that does not establish that their resources were released. This change does not add complete Scheduler restart support. The combined Tree `drop` workflow, non-default Feedback TFIDF, actual Java integration, full service HTTP E2E, and production-scale performance require separate validation.

TreeTextMemory.dump exports every state from one Cube. Its default omits vectors;
pass `include_embedding=True` for a full logical backup. GeneralMemCube.dump
requests vectors for openGauss Tree memory automatically. Files are published
with a same-directory atomic replacement only after writing, flushing, syncing,
and closing succeeds. A failed export or write preserves the previous file.
This guarantee covers one memory file, not the Cube's entire directory.

An explicit load fails on missing, unreadable, or invalid JSON files with
`memos.exceptions.MemoryError`. Database errors retain their cause. Restoration
is an atomic merge into the same Cube: it preserves nodes and edges absent from
the file. Importing a node without an embedding clears its existing embedding.
