# `core/episode/`

> **Episode lifecycle + stitching** (V7 §2.4.1, §2.6 Tier 2b).

## Why this directory is intentionally empty

V7 splits episode-related work across two responsibilities, and each
already has its own module:

| Concern                        | Lives in                                      |
| ------------------------------ | --------------------------------------------- |
| Lifecycle (open / close / reopen)  | `core/session/episode-manager.ts`         |
| V7 §0.1 relation classifier    | `core/session/relation-classifier.ts`         |
| Persistence adapter            | `core/session/persistence.ts` (`EpisodesRepo`)|
| SQL schema                     | `core/storage/migrations/001-initial.sql`     |
| Tier 2b "episode replay"       | `core/retrieval/tier2-trace.ts::rollupEpisodes` |
| Event aggregation              | `core/session/events.ts`                      |

Episode logic is intimate with session logic (same lifecycle bus, same
repo transactions), so folding it into `core/session/` avoids a circular
dependency between `core/episode/` and `core/session/`. The architecture
diagram in `ARCHITECTURE.md §3.2` lists this directory for **discoverability**
only — actual code belongs next to the session manager.

## Episode stitching in practice

V7 §2.4.1 calls out "episode stitching" as auxiliary — not a prerequisite
for L2 induction. We implement it implicitly:

1. `EpisodeManager.start` opens a row in `episodes`.
2. `pipeline/orchestrator.ts::onTurnStart` classifies the incoming user
   turn's relation to the previous episode (`revision` / `follow_up` /
   `new_task`) and either:
   - **reopens** the previous episode (revision, V7 §0.1),
   - **starts** a fresh episode in the same session (follow-up), or
   - **starts** a new session + episode (new task).
3. Capture attaches `trace_ids` to the episode on finalize.
4. Retrieval's Tier 2b reads all traces belonging to one episode and
   renders a **chronological action-sequence summary** when the
   episode's goal-level cosine clears `episodeGoalMinSim` — this is the
   "sub-task episode replay" V7 §2.6 Tier 2b describes.

## Invariants

- An episode always belongs to exactly one session.
- `episodes.status ∈ {'open', 'closed'}`. Reopening a closed episode
  (V7 §0.1 revision path) flips status back to `'open'` and records
  `meta.reopenReason`.
- Trace rows hold the authoritative `episode_id` foreign key; the
  episode's `trace_ids_json` is a denormalised convenience field
  (kept in sync by `EpisodeManager.attachTraceIds`).
- Episode lifecycle events are emitted on the `SessionEventBus`
  (`episode.started`, `episode.turn_added`, `episode.finalized`,
  `episode.abandoned`, `episode.reopened`, `episode.relation_classified`).

## Tests

- `tests/unit/session/episode-manager.test.ts` — lifecycle.
- `tests/unit/session/relation-classifier.test.ts` — V7 §0.1 routing.
- `tests/unit/retrieval/tier2.test.ts` — Tier 2b rollup + goal filter.
- `tests/unit/pipeline/memory-core.test.ts` — end-to-end through the
  orchestrator (revision + new_task routing integration).
