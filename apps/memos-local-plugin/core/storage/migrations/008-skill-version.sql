-- Migration 008 — per-skill version counter.
--
-- V7 §2.5 talks about skills as "continuously-revised" objects: every
-- rebuild / η adjustment / boundary refinement IS an evolution. Users
-- need to see "this skill has been revised N times" and "the current
-- body is at version V" on the Skills page.
--
-- Data model choice:
--   - Keep the current `skills` row as the canonical "latest version"
--     (so retrieval / invocation stays a single-row lookup).
--   - Add a monotonic `version` counter bumped on every rebuild.
--   - Surface history via the existing `api_logs` table — every
--     `skill.crystallized` / `skill.rebuilt` event already writes a
--     row there, so the Skills drawer can render a timeline with zero
--     extra DB writes.
--
-- Future: if we need diffs between versions or full-body snapshots,
-- we'll add a `skill_versions` history table. For now the current
-- body + the api_logs event stream is enough for the "version /
-- evolution count" UX the user asked for.

ALTER TABLE skills ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- Backfill: existing rows become v1. No-op given the DEFAULT above,
-- but explicit so the migration reads linearly.
UPDATE skills SET version = 1 WHERE version IS NULL;
