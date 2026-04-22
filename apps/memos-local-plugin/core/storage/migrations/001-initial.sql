-- Initial schema for memos-local-plugin. Applied exactly once per database
-- at first open. All later schema changes must be additive and live in their
-- own migration file (e.g. 002-add-…sql).
--
-- Conventions
--   * ids are TEXT (uuid v7 / short ids); timestamps are INTEGER ms epoch.
--   * JSON columns are TEXT with a sqlite "json" CHECK.
--   * Vector columns are BLOB (float32 little-endian). See core/storage/vector.ts.
--   * Every row gets `created_at` / `updated_at` (ms epoch) where it makes sense.

PRAGMA foreign_keys = ON;

-- ─── Schema metadata ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  INTEGER NOT NULL
) STRICT;

-- ─── Sessions & Episodes ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT    PRIMARY KEY,
  agent         TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  meta_json     TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS episodes (
  id            TEXT    PRIMARY KEY,
  session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  trace_ids_json TEXT   NOT NULL DEFAULT '[]' CHECK (json_valid(trace_ids_json)),
  r_task        REAL,
  status        TEXT    NOT NULL CHECK (status IN ('open','closed')) DEFAULT 'open',
  meta_json     TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status, started_at DESC);

-- ─── L1 Traces ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS traces (
  id               TEXT    PRIMARY KEY,
  episode_id       TEXT    NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  session_id       TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts               INTEGER NOT NULL,
  user_text        TEXT    NOT NULL,
  agent_text       TEXT    NOT NULL,
  tool_calls_json  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tool_calls_json)),
  reflection       TEXT,
  value            REAL    NOT NULL DEFAULT 0,
  alpha            REAL    NOT NULL DEFAULT 0,
  r_human          REAL,
  priority         REAL    NOT NULL DEFAULT 0,
  vec_summary      BLOB,
  vec_action       BLOB,
  schema_version   INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX IF NOT EXISTS idx_traces_episode_ts ON traces(episode_id, ts);
CREATE INDEX IF NOT EXISTS idx_traces_session_ts ON traces(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_traces_priority   ON traces(priority DESC);
CREATE INDEX IF NOT EXISTS idx_traces_abs_value  ON traces(abs(value) DESC);

-- ─── L2 Policies ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policies (
  id                TEXT    PRIMARY KEY,
  title             TEXT    NOT NULL,
  trigger           TEXT    NOT NULL,
  procedure         TEXT    NOT NULL,
  verification      TEXT    NOT NULL,
  boundary          TEXT    NOT NULL,
  support           INTEGER NOT NULL DEFAULT 0,
  gain              REAL    NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL CHECK (status IN ('candidate','active','retired')) DEFAULT 'candidate',
  source_episodes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_episodes_json)),
  induced_by        TEXT    NOT NULL DEFAULT '',
  vec               BLOB,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_policies_status     ON policies(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_policies_support    ON policies(support DESC, gain DESC);

-- Candidate pool for incremental L2 induction (§ V7 spec 4.2).
CREATE TABLE IF NOT EXISTS l2_candidate_pool (
  id                 TEXT    PRIMARY KEY,
  policy_id          TEXT REFERENCES policies(id) ON DELETE SET NULL,
  evidence_trace_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_trace_ids_json)),
  signature          TEXT    NOT NULL,
  similarity         REAL    NOT NULL DEFAULT 0,
  expires_at         INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_l2_candidate_sig     ON l2_candidate_pool(signature);
CREATE INDEX IF NOT EXISTS idx_l2_candidate_expires ON l2_candidate_pool(expires_at);

-- ─── L3 World-model ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS world_model (
  id              TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  policy_ids_json TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(policy_ids_json)),
  vec             BLOB,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_world_updated ON world_model(updated_at DESC);

-- ─── Skills ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills (
  id                    TEXT    PRIMARY KEY,
  name                  TEXT    NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('probationary','active','retired')) DEFAULT 'probationary',
  invocation_guide      TEXT    NOT NULL,
  procedure_json        TEXT    NOT NULL DEFAULT 'null' CHECK (json_valid(procedure_json)),
  eta                   REAL    NOT NULL DEFAULT 0,
  support               INTEGER NOT NULL DEFAULT 0,
  gain                  REAL    NOT NULL DEFAULT 0,
  trials_attempted      INTEGER NOT NULL DEFAULT 0,
  trials_passed         INTEGER NOT NULL DEFAULT 0,
  source_policies_json  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(source_policies_json)),
  source_world_json     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(source_world_json)),
  vec                   BLOB,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status, eta DESC);

-- ─── Feedback ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT    PRIMARY KEY,
  ts          INTEGER NOT NULL,
  episode_id  TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  trace_id    TEXT REFERENCES traces(id)   ON DELETE SET NULL,
  channel     TEXT    NOT NULL CHECK (channel IN ('explicit','implicit')),
  polarity    TEXT    NOT NULL CHECK (polarity IN ('positive','negative','neutral')),
  magnitude   REAL    NOT NULL DEFAULT 0,
  rationale   TEXT,
  raw_json    TEXT    NOT NULL DEFAULT 'null' CHECK (json_valid(raw_json))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback(ts DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_trace ON feedback(trace_id);
CREATE INDEX IF NOT EXISTS idx_feedback_episode ON feedback(episode_id);

-- ─── Decision repair history ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS decision_repairs (
  id                    TEXT    PRIMARY KEY,
  ts                    INTEGER NOT NULL,
  context_hash          TEXT    NOT NULL,
  preference            TEXT    NOT NULL,
  anti_pattern          TEXT    NOT NULL,
  high_value_traces_json TEXT   NOT NULL DEFAULT '[]' CHECK (json_valid(high_value_traces_json)),
  low_value_traces_json  TEXT   NOT NULL DEFAULT '[]' CHECK (json_valid(low_value_traces_json)),
  validated             INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_repairs_ts ON decision_repairs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_repairs_context ON decision_repairs(context_hash);

-- ─── Audit log (database-side). The file-based audit.log is separate. ──────
CREATE TABLE IF NOT EXISTS audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  actor       TEXT    NOT NULL,          -- "user" | "system" | "hub:<user>"
  kind        TEXT    NOT NULL,          -- "config.update" | "skill.retire" | ...
  target      TEXT,                      -- entity id, file path, etc.
  detail_json TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_kind ON audit_events(kind, ts DESC);

-- ─── Generic key-value store ───────────────────────────────────────────────
-- Used for tiny bookkeeping: last_trace_ts, installed_version, hub.last_sync_ts…
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL
) STRICT;
