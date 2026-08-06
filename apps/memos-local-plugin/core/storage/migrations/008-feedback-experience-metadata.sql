-- Add explicit metadata for feedback-derived experiences.
-- All ALTER TABLE columns backported into 001-initial.sql; only indexes remain here.

CREATE INDEX IF NOT EXISTS idx_policies_experience
  ON policies(experience_type, evidence_polarity, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_policies_skill_eligible
  ON policies(skill_eligible, status, updated_at DESC);
