-- Migration 004 — add `error_signatures_json` column to `traces`
-- (V7 §2.6 "结构匹配 — error signature 精确匹配").
--
-- Tier 2 retrieval now has three matching levels:
--   1. structural match → exact-substring lookup on this column
--   2. semantic match   → vector cosine (existing `vec_*` columns)
--   3. tag match        → existing `tags_json` column
--
-- We store normalised error fragments (≤ 160 chars each, ≤ 4 per trace)
-- as a JSON text array: ["pg_config: not found", "EACCES: /tmp", ...].
--
-- Writes happen in `core/capture/error-signature.ts` and are invoked
-- from the capture pipeline before `tracesRepo.insert`. Existing rows
-- default to `'[]'` so cold-start indexing is non-destructive.
--
-- No dedicated index: lookups use SQLite's `instr(error_signatures_json, ?)`
-- which is O(n) on row count but fast enough at our expected scale
-- (< 1e6 rows on a single user box). When we cross that, revisit with a
-- `tokens` virtual table or an FTS index.

ALTER TABLE traces ADD COLUMN error_signatures_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(error_signatures_json));
