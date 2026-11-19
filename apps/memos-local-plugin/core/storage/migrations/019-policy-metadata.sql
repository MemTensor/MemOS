-- Structured provenance for L2 policies. Nullable for backwards compatibility;
-- legacy rows continue to use the L3 text heuristic until re-induced.
ALTER TABLE policies ADD COLUMN metadata_json TEXT;
CREATE INDEX IF NOT EXISTS idx_policies_metadata ON policies(metadata_json);
