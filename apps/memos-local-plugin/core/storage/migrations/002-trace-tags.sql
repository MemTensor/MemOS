-- Migration 002 — add `tags_json` column to `traces` for Tier-2 pre-filtering
-- (V7 §2.6 "每条 trace 带有自动标注的领域标签").
--
-- We keep the column as a JSON text array (['docker','pip','plugin']) instead
-- of a separate tags table; retrieval does substring-or-JSON-lookup checks,
-- not join-heavy queries, so there's no win from a normalized shape.
--
-- The column defaults to `'[]'` so existing rows remain valid. No index is
-- required — tag matching happens in the Tier 2 candidate-pool builder with
-- SQLite's `instr()` on the raw JSON string, which is fast enough at our
-- expected scale (<= 1e6 rows on a single user box).

ALTER TABLE traces ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(tags_json));
