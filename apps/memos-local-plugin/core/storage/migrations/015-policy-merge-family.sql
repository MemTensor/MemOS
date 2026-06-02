ALTER TABLE policies
  ADD COLUMN merge_family TEXT
  CHECK (merge_family IN ('success_induction','failure_corrective','failure_avoidance'));

CREATE INDEX IF NOT EXISTS idx_policies_merge_family
  ON policies(merge_family, status, updated_at DESC);
