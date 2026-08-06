# `core/memory/l1/`

> **L1 — step-level grounded trace memory** (V7 §0.4, §2.4.1).

## Why this directory is intentionally empty

L1 is the foundational memory layer — it stores the step-level tuple
`(s_t, a_t, o_t, ρ_t, r_t)` described in V7 §0.4. But in this codebase
**L1 does not get its own module**: its read/write surface already lives
where the rest of the storage layer lives, and duplicating it here would
only make refactors more painful.

Concretely:

| L1 concern                | Where it lives                                       |
| ------------------------- | ---------------------------------------------------- |
| Schema (columns, indexes) | `core/storage/migrations/001-initial.sql` (`traces`) |
| Row shape (`TraceRow`)    | `core/types.ts`                                      |
| Repository (CRUD + search)| `core/storage/repos/traces.ts`                       |
| Trace **writing**         | `core/capture/capture.ts` (5-stage pipeline)         |
| Trace **reward update**   | `core/reward/backprop.ts` + `reward/subscriber.ts`   |
| Trace **retrieval**       | `core/retrieval/tier2-trace.ts`                      |
| Structural match input    | `core/capture/error-signature.ts`                    |
| Domain-tag enrichment     | `core/capture/tagger.ts`                             |

Every new L1 feature should land in one of those modules. Add a line to
the table above when that happens so future readers can jump straight to
the right spot.

## L2 / L3 have their own directories — why not L1?

L2 (policy induction) and L3 (world-model abstraction) are
algorithm-heavy: each owns a subscriber, an inducer/clustered prompt, a
signature or similarity function, and a lifecycle. They *need* a
directory per concern.

L1, on the other hand, is just **storage + a few cheap write-time
enrichments** (tags, error signatures). There's no induction, no
clustering, no retired/active state. Bundling those enrichments with the
capture pipeline keeps the dependency graph acyclic and avoids a thin
"L1 module" that is mostly re-exports.

## Invariants (see `core/capture/ALGORITHMS.md` for the full list)

- Every finalized episode produces ≥ 1 L1 trace, regardless of reward or
  capture success. A failed capture still emits a trace stub so the
  episode timeline is never empty.
- `TraceRow.errorSignatures` is optional at the type level (new column
  in migration 004), always a `string[]` in storage (default `'[]'`).
- `TraceRow.value` starts at 0 and is only modified by
  `core/reward/backprop.ts` — never by capture or retrieval.
- L1 rows are **never deleted** during normal operation. V7 §0.6 calls
  for "permanent retention with priority decay"; enforcement is in
  `core/storage/repos/traces.ts` (only `deleteById` exposed, reserved
  for operator-initiated GDPR deletions).

## Tests

Storage-level guarantees live in:
- `tests/unit/storage/repos.test.ts` — CRUD, scoring, vector search.
- `tests/unit/capture/` — one file per write-pipeline stage.
- `tests/unit/retrieval/tier2.test.ts` — L1 read path.
