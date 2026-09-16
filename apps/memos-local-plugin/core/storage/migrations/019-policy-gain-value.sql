-- separate policy gain from normalized reward credit.
--
-- SCHEMA-ONLY migration. It adds columns and the repair queue/journal tables
-- and does NOTHING else: no data conversion, no queue seeding, no policy or
-- trace writes, no budget reset. Historical inference is an idempotent
-- TypeScript pass (core/reward/gain-inference.ts) that runs after migrations
-- and before consumers/timer start.
--
-- Owner-column decision: the queue/journal tables declare their own
-- owner_agent_kind / owner_profile_id / owner_workspace_id columns inline
-- (matching migration 007's NS_TABLES convention) instead of being added to
-- the migrator's NS_TABLES list. NS_TABLES drives migration-007 backfill and
-- shared index creation for tables that predate namespacing; these tables are
-- new and namespaced from birth, so handling it inline here keeps the blast
-- radius contained.
--
-- Post-write timestamp: the journal also records the policy `updated_at`
-- written by the completing repair attempt.
-- `policies.gainRollback` compares-and-swaps all five repair-written policy
-- fields (status, support, gain, gain_version, updated_at) against the
-- recorded post-write state before restoring anything. Without this column a
-- newer-timestamp write could not be detected. Rows carrying NULL here (never
-- recorded, or non-completing outcomes) are NOT rollback-eligible — a
-- rollback must prove ownership of the exact post-write state, never guess
-- it.

-- traces: NULL gain_value means UNRESOLVED, not neutral zero.
ALTER TABLE traces
  ADD COLUMN gain_value REAL;

ALTER TABLE traces
  ADD COLUMN gain_value_source TEXT
  CHECK (gain_value_source IS NULL OR gain_value_source IN
    ('live_normalized','inferred_normalized','legacy_unscaled'));

-- 0 = never screened; stamped (1, 2, ...) on EVERY historical screening
-- attempt, including attempts that stay unresolved, so a restart never
-- rescans stamped groups.
ALTER TABLE traces
  ADD COLUMN gain_inference_version INTEGER NOT NULL DEFAULT 0;

-- policies: version 2 certifies the shared gain calculation; the column is
-- additive and default 1 (uncertified). Nothing here writes it.
ALTER TABLE policies
  ADD COLUMN gain_version INTEGER NOT NULL DEFAULT 1;

-- Repair queue keyed by policy ID. archived policies are never repair
-- targets; state is pending/blocked/claimed with reason + attempt metadata.
CREATE TABLE IF NOT EXISTS gain_repair_queue (
  policy_id            TEXT    PRIMARY KEY REFERENCES policies(id) ON DELETE CASCADE,
  owner_agent_kind     TEXT    NOT NULL DEFAULT 'unknown',
  owner_profile_id     TEXT    NOT NULL DEFAULT 'default',
  owner_workspace_id   TEXT,
  state                TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (state IN ('pending','blocked','claimed')),
  reason               TEXT,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at      INTEGER,
  last_attempt_batch_id TEXT,
  inference_version    INTEGER NOT NULL DEFAULT 1,
  blocked_reason       TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_gain_repair_queue_owner_state
  ON gain_repair_queue(owner_agent_kind, owner_profile_id, state, updated_at);

-- Repair journal: batch/attempt ID, namespace, old/new policy fields,
-- config/algorithm versions, provenance/exclusion counts, timestamp, result.
CREATE TABLE IF NOT EXISTS gain_repair_journal (
  id                     TEXT    PRIMARY KEY,
  batch_id               TEXT    NOT NULL,
  owner_agent_kind       TEXT    NOT NULL DEFAULT 'unknown',
  owner_profile_id       TEXT    NOT NULL DEFAULT 'default',
  owner_workspace_id     TEXT,
  policy_id              TEXT    REFERENCES policies(id) ON DELETE SET NULL,
  old_gain               REAL,
  new_gain               REAL,
  old_gain_version       INTEGER,
  new_gain_version       INTEGER,
  old_status             TEXT,
  new_status             TEXT,
  old_support            INTEGER,
  new_support            INTEGER,
  algorithm_version      TEXT,
  config_version         TEXT,
  inference_version      INTEGER NOT NULL DEFAULT 1,
  provenance_json        TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(provenance_json)),
  excluded_with_count    INTEGER NOT NULL DEFAULT 0,
  excluded_without_count INTEGER NOT NULL DEFAULT 0,
  result                 TEXT    NOT NULL DEFAULT 'pending'
                                CHECK (result IN
                                  ('pending','completed','blocked','conflicted','failed','rolled_back')),
  created_at             INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_gain_repair_journal_owner_ts
  ON gain_repair_journal(owner_agent_kind, owner_profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gain_repair_journal_batch
  ON gain_repair_journal(batch_id);

-- Folded-in post-write timestamp (former 908): recorded post-write policy
-- `updated_at` for the five-field CAS rollback. NULLABLE so rows that never
-- record it (non-completing outcomes) stay NOT rollback-eligible.
ALTER TABLE gain_repair_journal
  ADD COLUMN new_updated_at INTEGER;
