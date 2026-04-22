-- Migration 009 — share + edit metadata for skills, policies, world models.
--
-- The viewer's drawer footers gained share / edit / archive buttons for
-- the L2 (policies / "经验"), L3 (world models / "世界环境知识"), and
-- skills tiers. Mirrors what migration 006 did for traces:
--
--   `share_scope`    — 'private' | 'public' | 'hub' (NULL = not shared)
--   `share_target`   — free-form target reference (hub memory id,
--                      public link token, etc.)
--   `shared_at`      — unix-ms when the last share action ran
--   `edited_at`      — unix-ms when the user last edited the row's body
--                      via the viewer's edit modal (distinct from
--                      `updated_at`, which the algorithm pipeline owns)
--
-- World models additionally get a soft-archive lifecycle, since the
-- existing `DELETE` is destructive and the viewer wants a reversible
-- "归档 / 取消归档" affordance:
--
--   `status`         — 'active' | 'archived' (NEW; defaults to 'active'
--                      so existing rows keep their behaviour).
--   `retired_at`     — unix-ms when the user archived the row
--                      (NULL while active).
--
-- Skills already have a 'retired' status and a separate retire flow
-- (`retireSkill`), so we don't add a parallel status column there —
-- the new "hard delete" + "reactivate" actions reuse `setStatus` and
-- `deleteById`.

ALTER TABLE skills       ADD COLUMN share_scope  TEXT;
ALTER TABLE skills       ADD COLUMN share_target TEXT;
ALTER TABLE skills       ADD COLUMN shared_at    INTEGER;
ALTER TABLE skills       ADD COLUMN edited_at    INTEGER;

ALTER TABLE policies     ADD COLUMN share_scope  TEXT;
ALTER TABLE policies     ADD COLUMN share_target TEXT;
ALTER TABLE policies     ADD COLUMN shared_at    INTEGER;
ALTER TABLE policies     ADD COLUMN edited_at    INTEGER;

ALTER TABLE world_model  ADD COLUMN share_scope  TEXT;
ALTER TABLE world_model  ADD COLUMN share_target TEXT;
ALTER TABLE world_model  ADD COLUMN shared_at    INTEGER;
ALTER TABLE world_model  ADD COLUMN edited_at    INTEGER;
ALTER TABLE world_model  ADD COLUMN status       TEXT NOT NULL DEFAULT 'active';
ALTER TABLE world_model  ADD COLUMN retired_at   INTEGER;
