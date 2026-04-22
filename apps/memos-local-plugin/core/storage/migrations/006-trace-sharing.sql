-- Migration 006 — add sharing metadata to `traces`
--
-- Parity with `memos-local-openclaw`'s share workflow: the user can
-- mark a memory as private/public/hub and optionally anonymize it
-- before handing it to the Hub. We need three nullable fields to
-- track the state locally:
--
--   `share_scope`    — 'private' | 'public' | 'hub' (NULL = not shared)
--   `share_target`   — free-form target reference (hub memory id,
--                      public link token, etc.)
--   `shared_at`      — unix-ms when the last share action ran
--
-- Nothing else in the pipeline depends on these columns; they are
-- pure viewer/admin-layer state. Keeping them on `traces` (rather
-- than a side table) matches the legacy `chunks` shape the old
-- viewer expected.

ALTER TABLE traces ADD COLUMN share_scope TEXT;
ALTER TABLE traces ADD COLUMN share_target TEXT;
ALTER TABLE traces ADD COLUMN shared_at INTEGER;
