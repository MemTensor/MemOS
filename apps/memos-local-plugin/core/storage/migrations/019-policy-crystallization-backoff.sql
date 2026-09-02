-- Persistent per-policy back-off state for skill crystallization retries.
--
-- Before this migration `runSkill` retried failing policies on every trigger
-- (l2.policy.induced / l2.policy.updated / reward.updated) with no state
-- ever written back, and the documented `skill.cooldownMs` config was never
-- wired into the subscriber. A single permanently-failing policy could
-- accumulate thousands of repeated LLM refusals / verifier mismatches over
-- weeks, burning budget and log volume forever (issue #2319: 2,640 repeated
-- failures observed in a 25-day audit of a local deployment).
--
-- Adding four small columns lets `evaluateEligibility` skip a policy that
-- recently failed (exponential back-off, capped at 24h) or quarantine it
-- entirely after `crystallizationMaxAttempts` (default 8). Auto-invalidation
-- is implicit: whenever `policy.updated_at` moves past
-- `crystallization_last_attempt_at`, the eligibility check treats the
-- back-off state as stale and lets the retry through.
--
-- All four columns are additive with safe defaults, so pre-migration rows
-- read as "never attempted" and existing installs pick up back-off gating
-- only for policies that fail after this deploy.

ALTER TABLE policies ADD COLUMN crystallization_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE policies ADD COLUMN crystallization_backoff_until INTEGER;
ALTER TABLE policies ADD COLUMN crystallization_last_attempt_at INTEGER;
ALTER TABLE policies ADD COLUMN crystallization_last_failure_reason TEXT;
