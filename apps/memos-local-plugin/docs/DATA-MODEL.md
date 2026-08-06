# Data model

This document is the authoritative column-level reference for the plugin's
SQLite database. Any change to `core/storage/migrations/*.sql` must be
reflected here in the same PR.

> Conventions
>
> - **IDs** are `TEXT` (uuid v7 or short Crockford base32).
> - **Timestamps** are `INTEGER` milliseconds since the UTC epoch.
> - **JSON columns** are `TEXT CHECK (json_valid(…))`.
> - **Vector columns** are `BLOB` holding little-endian `Float32` (see
>   `core/storage/vector.ts`).

## `schema_migrations`

Tracks applied schema migrations.

| Column      | Type    | Notes                                       |
|-------------|---------|---------------------------------------------|
| version     | INTEGER | PK. Monotonic, from the migration filename. |
| name        | TEXT    | Slug portion of the migration filename.     |
| applied_at  | INTEGER | When the migration ran (ms epoch).          |

## `sessions`

One row per adapter-reported session (e.g. one OpenClaw CLI invocation).

| Column        | Type    | Notes                                |
|---------------|---------|--------------------------------------|
| id            | TEXT    | PK.                                  |
| agent         | TEXT    | `openclaw` \| `hermes` \| future.    |
| started_at    | INTEGER | ms epoch.                            |
| last_seen_at  | INTEGER | ms epoch; bumped on every turn.      |
| meta_json     | TEXT    | JSON; adapter-defined bag.           |

Indexes: `idx_sessions_last_seen`.

## `episodes`

A group of traces forming one task.

| Column            | Type    | Notes                                      |
|-------------------|---------|--------------------------------------------|
| id                | TEXT    | PK.                                        |
| session_id        | TEXT    | FK `sessions.id`, `ON DELETE CASCADE`.     |
| started_at        | INTEGER | ms epoch.                                  |
| ended_at          | INTEGER | ms epoch; null while `status='open'`.      |
| trace_ids_json    | TEXT    | JSON array of trace ids, in time order.    |
| r_task            | REAL    | Task-level reward in \[-1, 1\], if any.    |
| status            | TEXT    | `open` \| `closed`.                        |
| meta_json         | TEXT    | JSON; stitcher bookkeeping, task tags.     |

Indexes: `idx_episodes_session (session_id, started_at DESC)`,
`idx_episodes_status (status, started_at DESC)`.

## `traces` (L1)

One row per dialogue turn.

| Column           | Type    | Notes                                                |
|------------------|---------|------------------------------------------------------|
| id               | TEXT    | PK.                                                  |
| episode_id       | TEXT    | FK `episodes.id`, `ON DELETE CASCADE`.               |
| session_id       | TEXT    | FK `sessions.id`, `ON DELETE CASCADE`.               |
| ts               | INTEGER | ms epoch.                                            |
| user_text        | TEXT    | What the user said this turn.                        |
| agent_text       | TEXT    | What the agent said this turn.                       |
| tool_calls_json  | TEXT    | JSON `ToolCallDTO[]`.                                |
| reflection       | TEXT    | Optional reflection text.                            |
| value            | REAL    | V_t (backpropagated).                                |
| alpha            | REAL    | α_t (reflection weight).                             |
| r_human          | REAL    | Signed human reward, if known.                       |
| priority         | REAL    | Cached priority (for L2 candidate selection).        |
| vec_summary      | BLOB    | Float32 embedding of the turn summary.               |
| vec_action       | BLOB    | Float32 embedding of the action sequence.            |
| schema_version   | INTEGER | Row-level schema rev (for re-embed on dim change).   |

Indexes: `idx_traces_episode_ts`, `idx_traces_session_ts`,
`idx_traces_priority`, `idx_traces_abs_value`.

## `policies` (L2)

Induced policies (candidates → active → retired).

| Column                | Type    | Notes                                     |
|-----------------------|---------|-------------------------------------------|
| id                    | TEXT    | PK.                                       |
| title                 | TEXT    | Short human-readable name.                |
| trigger               | TEXT    | When to apply.                            |
| procedure             | TEXT    | What to do (prose or reference).          |
| verification          | TEXT    | How to verify success.                    |
| boundary              | TEXT    | Where the policy doesn't apply.           |
| support               | INTEGER | # supporting episodes.                    |
| gain                  | REAL    | Average ΔV across supporting traces.      |
| status                | TEXT    | `candidate` \| `active` \| `retired`.     |
| source_episodes_json  | TEXT    | JSON episode-id array.                    |
| induced_by            | TEXT    | Prompt id that produced this policy.      |
| vec                   | BLOB    | Embedding used for retrieval.             |
| created_at            | INTEGER | ms epoch.                                 |
| updated_at            | INTEGER | ms epoch.                                 |

Indexes: `idx_policies_status`, `idx_policies_support`.

## `l2_candidate_pool`

Fingerprint-addressed rolling pool used by the incremental / cross-task
inducers before a candidate gets promoted.

| Column                    | Type    | Notes                                       |
|---------------------------|---------|---------------------------------------------|
| id                        | TEXT    | PK.                                         |
| policy_id                 | TEXT    | FK `policies.id`; null until promoted.      |
| evidence_trace_ids_json   | TEXT    | JSON array of contributing trace ids.       |
| signature                 | TEXT    | Semantic fingerprint (hash of gist).        |
| similarity                | REAL    | Internal score \[0, 1\].                    |
| expires_at                | INTEGER | ms epoch; pruned by `.prune(nowMs)`.        |

Indexes: `idx_l2_candidate_sig`, `idx_l2_candidate_expires`.

## `world_model` (L3)

| Column           | Type    | Notes                                 |
|------------------|---------|---------------------------------------|
| id               | TEXT    | PK.                                   |
| title            | TEXT    | Short name.                           |
| body             | TEXT    | Prose describing the world fragment.  |
| policy_ids_json  | TEXT    | JSON array of source policy ids.      |
| vec              | BLOB    | Embedding for retrieval.              |
| created_at       | INTEGER | ms epoch.                             |
| updated_at       | INTEGER | ms epoch.                             |

Indexes: `idx_world_updated`.

## `skills`

Crystallized, callable skills.

| Column                | Type    | Notes                                        |
|-----------------------|---------|----------------------------------------------|
| id                    | TEXT    | PK.                                          |
| name                  | TEXT    | Unique handle used by `skill.<name>` tools.  |
| status                | TEXT    | `probationary` \| `active` \| `retired`.     |
| invocation_guide      | TEXT    | Plain-text guide injected at Tier-1.         |
| procedure_json        | TEXT    | Optional structured procedure.               |
| eta                   | REAL    | Adoption rate in \[0, 1\].                   |
| support               | INTEGER | Supporting episodes.                         |
| gain                  | REAL    | V_with − V_without.                          |
| trials_attempted      | INTEGER | Counter used by the verifier.                |
| trials_passed         | INTEGER | Counter used by the verifier.                |
| source_policies_json  | TEXT    | JSON array of policy ids.                    |
| source_world_json     | TEXT    | JSON array of world-model ids.               |
| vec                   | BLOB    | Embedding.                                   |
| created_at            | INTEGER | ms epoch.                                    |
| updated_at            | INTEGER | ms epoch.                                    |

Indexes: `uq_skills_name` (UNIQUE on `name`), `idx_skills_status`.

## `feedback`

| Column      | Type    | Notes                                                  |
|-------------|---------|--------------------------------------------------------|
| id          | TEXT    | PK.                                                    |
| ts          | INTEGER | ms epoch.                                              |
| episode_id  | TEXT    | FK `episodes.id`, `ON DELETE SET NULL`.                |
| trace_id    | TEXT    | FK `traces.id`, `ON DELETE SET NULL`.                  |
| channel     | TEXT    | `explicit` \| `implicit`.                              |
| polarity    | TEXT    | `positive` \| `negative` \| `neutral`.                 |
| magnitude   | REAL    | \[0, 1\].                                              |
| rationale   | TEXT    | Optional free-text.                                    |
| raw_json    | TEXT    | Adapter-specific raw payload.                          |

Indexes: `idx_feedback_ts`, `idx_feedback_trace`, `idx_feedback_episode`.

## `decision_repairs`

Preference / anti-pattern pairs generated by the decision-repair pipeline.

| Column                    | Type    | Notes                                     |
|---------------------------|---------|-------------------------------------------|
| id                        | TEXT    | PK.                                       |
| ts                        | INTEGER | ms epoch.                                 |
| context_hash              | TEXT    | Hash of the triggering context.           |
| preference                | TEXT    | Plain-text "do this".                     |
| anti_pattern              | TEXT    | Plain-text "don't do this".               |
| high_value_traces_json    | TEXT    | JSON array of evidence trace ids.         |
| low_value_traces_json     | TEXT    | JSON array of evidence trace ids.         |
| validated                 | INTEGER | 0/1; true once the repair was honored.    |

Indexes: `idx_repairs_ts`, `idx_repairs_context`.

## `audit_events`

Immutable database-side audit log. Mirrored to `logs/audit.log` (also kept
forever). Both sinks are "append-only" — no `UPDATE` or `DELETE` should ever
be issued here.

| Column      | Type    | Notes                                                  |
|-------------|---------|--------------------------------------------------------|
| id          | INTEGER | AUTOINCREMENT PK.                                      |
| ts          | INTEGER | ms epoch.                                              |
| actor       | TEXT    | `user` \| `system` \| `hub:<user>`.                    |
| kind        | TEXT    | e.g. `config.update`, `skill.retire`, `hub.join`.      |
| target      | TEXT    | Entity id, file path, etc.                             |
| detail_json | TEXT    | JSON payload.                                          |

Indexes: `idx_audit_ts`, `idx_audit_kind`.

## `kv`

Tiny key/value scratch space.

| Column      | Type    | Notes                                  |
|-------------|---------|----------------------------------------|
| key         | TEXT    | PK.                                    |
| value_json  | TEXT    | JSON-serialized payload.               |
| updated_at  | INTEGER | ms epoch.                              |

Examples of keys used across the codebase:

- `system.installed_version`
- `system.last_shutdown_ts`
- `hub.last_sync_at`
- `telemetry.last_batch_id`
- `retrieval.cache_gen` (bump to invalidate in-memory caches)
