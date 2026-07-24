-- Durable semantic-evolution work queue. Capture requests commit L1 rows and
-- enqueue here; one runtime-owned worker performs reflection/reward/L2/L3/Skill.
CREATE TABLE IF NOT EXISTS evolution_jobs (
  id                TEXT    PRIMARY KEY,
  job_type          TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'failed', 'succeeded', 'dead_letter')),
  dedupe_key        TEXT,
  payload_json      TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  available_at      INTEGER NOT NULL,
  claimed_by        TEXT,
  lease_until       INTEGER,
  rerun_requested   INTEGER NOT NULL DEFAULT 0 CHECK (rerun_requested IN (0, 1)),
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_evolution_jobs_due
  ON evolution_jobs(status, available_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_evolution_jobs_active_dedupe
  ON evolution_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'leased', 'failed');
