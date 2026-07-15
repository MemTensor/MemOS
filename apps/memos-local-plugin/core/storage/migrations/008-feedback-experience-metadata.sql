-- Add explicit metadata for feedback-derived experiences.
-- Existing policies are treated as success-backed procedural experience so
-- skill crystallization keeps its legacy behavior for old rows.
ALTER TABLE policies ADD COLUMN experience_type TEXT NOT NULL DEFAULT 'success_pattern'
  CHECK (experience_type IN ('success_pattern','repair_validated','failure_avoidance','repair_instruction','preference','verifier_feedback','procedural'));
ALTER TABLE policies ADD COLUMN evidence_polarity TEXT NOT NULL DEFAULT 'positive'
  CHECK (evidence_polarity IN ('positive','negative','neutral','mixed'));
ALTER TABLE policies ADD COLUMN salience REAL NOT NULL DEFAULT 0;
ALTER TABLE policies ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE policies ADD COLUMN source_feedback_ids_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(source_feedback_ids_json));
ALTER TABLE policies ADD COLUMN source_trace_ids_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(source_trace_ids_json));
ALTER TABLE policies ADD COLUMN verifier_meta_json TEXT NOT NULL DEFAULT 'null'
  CHECK (json_valid(verifier_meta_json));
ALTER TABLE policies ADD COLUMN skill_eligible INTEGER NOT NULL DEFAULT 1
  CHECK (skill_eligible IN (0,1));

CREATE INDEX IF NOT EXISTS idx_policies_experience
  ON policies(experience_type, evidence_polarity, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_policies_skill_eligible
  ON policies(skill_eligible, status, updated_at DESC);
