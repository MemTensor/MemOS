-- Add L3 world-model versioning. New rows start at v1; L3 merge/update
-- increments the counter in the repository.
ALTER TABLE world_model ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
