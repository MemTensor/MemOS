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
--
-- Runtime note: at plugin boot the migrator (`storage/migrator.ts`) does
-- NOT execute this file via `db.exec`; it dispatches version 19 to
-- `ensurePolicyCrystallizationBackoffColumns`, which uses `ensureColumn`
-- so partial-schema test harnesses (no `policies` table) and re-runs on
-- an already-migrated DB stay idempotent. This file is kept as the
-- authoritative on-disk schema-of-record for tooling that reads the
-- migrations directory directly (dry-run diff, manual recovery, future
-- non-SQLite backend ports); both paths produce the same four columns.
-- If you edit either side, update the other to match.

ALTER TABLE policies ADD COLUMN crystallization_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE policies ADD COLUMN crystallization_backoff_until INTEGER;
ALTER TABLE policies ADD COLUMN crystallization_last_attempt_at INTEGER;
ALTER TABLE policies ADD COLUMN crystallization_last_failure_reason TEXT;

-- Partial index for bulk lookups of policies currently inside the back-off
-- window. Not needed by `evaluateEligibility` (which reads the state from
-- the already-loaded `PolicyRow`), but keeps future health-check dashboards,
-- bulk-reset commands, and audit queries off a full table scan.
CREATE INDEX IF NOT EXISTS idx_policies_crystallization_backoff
  ON policies(crystallization_backoff_until)
  WHERE crystallization_backoff_until IS NOT NULL;
