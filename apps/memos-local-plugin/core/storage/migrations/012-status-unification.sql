-- Migration 012 — unify lifecycle status terminology across L2 policies,
-- skills, and L3 world models.
--
-- Background
-- ──────────
-- The three canonical memory objects grew their own vocabulary for the
-- same three lifecycle states:
--   - L2 policies:    candidate  | active | retired
--   - Skills:         probationary | active | retired
--   - L3 world-model: active | archived                (no candidate)
--
-- This left the viewer with inconsistent chips/pills/action buttons ("候选"
-- vs "试用", "激活" vs "已启用", "已归档" vs "retired", etc.). Since the
-- plugin is still pre-release, we take the opportunity to collapse the
-- vocabulary before it ossifies.
--
-- Unified after this migration
-- ────────────────────────────
--   - L2 policies:    candidate | active | archived
--   - Skills:         candidate | active | archived   (probationary → candidate)
--   - L3 world-model: active | archived               (unchanged; no candidate)
--
-- Column rename:
--   - world_model.retired_at   → archived_at
--
-- Approach
-- ────────
-- 1. UPDATE the existing rows so they match the new value set (so the
--    new CHECK constraint cannot fail).
-- 2. Use the `PRAGMA writable_schema` trick to swap the CHECK constraint
--    in-place (avoids rebuilding the tables and recreating every
--    index/trigger/FTS mirror).
-- 3. Rename the `retired_at` column on `world_model` to `archived_at`.
-- 4. Verify everything still lines up with `PRAGMA integrity_check`.

-- ─── 1. Migrate existing rows to the unified value set ────────────────
UPDATE policies
   SET status = 'archived'
 WHERE status = 'retired';

UPDATE skills
   SET status = 'candidate'
 WHERE status = 'probationary';

UPDATE skills
   SET status = 'archived'
 WHERE status = 'retired';

-- ─── 2. Swap CHECK constraints in sqlite_master ───────────────────────
PRAGMA writable_schema = 1;

UPDATE sqlite_master
   SET sql = replace(
       sql,
       "CHECK (status IN ('candidate','active','retired'))",
       "CHECK (status IN ('candidate','active','archived'))"
   )
 WHERE type = 'table'
   AND name = 'policies';

UPDATE sqlite_master
   SET sql = replace(
       sql,
       "CHECK (status IN ('probationary','active','retired'))",
       "CHECK (status IN ('candidate','active','archived'))"
   )
 WHERE type = 'table'
   AND name = 'skills';

-- Update default values so future INSERTs without a `status` land on
-- `candidate` (skills used to default to `'probationary'`).
UPDATE sqlite_master
   SET sql = replace(sql, "DEFAULT 'probationary'", "DEFAULT 'candidate'")
 WHERE type = 'table'
   AND name = 'skills';

PRAGMA writable_schema = 0;

-- ─── 3. Rename world_model.retired_at → archived_at ──────────────────
ALTER TABLE world_model RENAME COLUMN retired_at TO archived_at;

-- ─── 4. Sanity check (non-fatal; SQLite will throw if schema broken) ─
PRAGMA integrity_check;
