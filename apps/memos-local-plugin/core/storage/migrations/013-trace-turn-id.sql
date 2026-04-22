-- Migration 013 — add `turn_id` column to `traces`.
--
-- What
-- ────
-- A new INTEGER column (nullable) on `traces` that carries a stable
-- identifier shared by every L1 trace produced from the same user
-- message. Defaults to the user turn's `ts` (epoch ms).
--
-- Why
-- ───
-- V7 §0.1 keeps L1 traces at the step level (one tool call → one
-- trace, plus one trace for the final reply). Algorithm machinery —
-- reflection-weighted backprop, L2 incremental association, Tier-2
-- error-signature retrieval, Decision Repair — all need that step
-- granularity.
--
-- The viewer, however, wants to surface a coherent "one round = one
-- memory" card so users aren't drowned in N rows per question. The
-- frontend collapses sibling sub-steps into a single card by grouping
-- on `(episode_id, turn_id)`; this column is the stable group key
-- that survives reorderings, late-arriving rows, and partial
-- captures.
--
-- Shape
-- ─────
-- `INTEGER NULL`. Filled in by `step-extractor` (writes the user
-- turn's `ts` into every sub-step's `meta.turnId`, which capture.ts
-- threads through to the row). Older rows from before this migration
-- stay NULL and the viewer falls back to per-row rendering for them.
--
-- Indexing
-- ────────
-- Indexed by `(episode_id, turn_id)` so the timeline endpoint can
-- group rows in a single scan without sorting in JS.
--
-- FTS integration
-- ───────────────
-- N/A — this is a numeric grouping key, not searchable text.

ALTER TABLE traces ADD COLUMN turn_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_traces_episode_turn
  ON traces(episode_id, turn_id, ts);
