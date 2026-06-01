-- 014: Episode outcome cache (verifier_passed + outcome).
-- See docs/superpowers/specs/2026-06-01-failure-aware-skill-sinking-design.md §2.1.
--
-- verifier_passed: tri-state INTEGER (1 = pass, 0 = fail, NULL = unknown).
-- outcome: cached classification computed from (verifier_passed, r_task)
--          via core/episode/outcome.ts:computeEpisodeOutcome.

ALTER TABLE episodes ADD COLUMN verifier_passed INTEGER NULL;
ALTER TABLE episodes ADD COLUMN outcome TEXT NULL
  CHECK (outcome IS NULL OR outcome IN ('success', 'failure', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_episodes_outcome ON episodes(outcome);
