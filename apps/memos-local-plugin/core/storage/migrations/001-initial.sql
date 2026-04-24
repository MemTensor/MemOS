-- Initial schema for memos-local-plugin.
--
-- This is the **single, authoritative schema** for a fresh database.
-- Historical migrations (002–014) used to evolve this schema in place;
-- they have been squashed into this file because the plugin is still
-- pre-release and we explicitly do not preserve old data — every
-- install wipes the previous DB. New incremental schema changes go
-- into `002-…sql` etc. as usual.
--
-- Conventions
--   * ids are TEXT (uuid v7 / short ids); timestamps are INTEGER ms epoch.
--   * JSON columns are TEXT with a sqlite "json" CHECK.
--   * Vector columns are BLOB (float32 little-endian). See core/storage/vector.ts.
--   * Every row gets `created_at` / `updated_at` (ms epoch) where it makes sense.
--   * Lifecycle status is unified across all three layers:
--       L2 policies: candidate | active | archived
--       Skills:      candidate | active | archived
--       L3 world:    active | archived (no candidate)

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
-- Includes (compared to the absolute-minimum trace shape):
--   tags_json             — V7 §2.6 Tier-2 pre-filter tags (was migration 002)
--   error_signatures_json — V7 §2.6 structural-match channel (was 004)
--   summary               — LLM-generated short line for the viewer (was 005)
--   share_scope/...       — Hub sharing metadata (was 006)
--   agent_thinking        — model native thinking text per step (was 011)
--   turn_id               — UI grouping key (NOT NULL); every L1 trace
--                           carries the user-turn `ts` shared by all
--                           sub-steps of the same user message.
CREATE TABLE IF NOT EXISTS traces (
  id                    TEXT    PRIMARY KEY,
  episode_id            TEXT    NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  session_id            TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts                    INTEGER NOT NULL,
  user_text             TEXT    NOT NULL,
  agent_text            TEXT    NOT NULL,
  summary               TEXT,
  tool_calls_json       TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tool_calls_json)),
  reflection            TEXT,
  agent_thinking        TEXT,
  value                 REAL    NOT NULL DEFAULT 0,
  alpha                 REAL    NOT NULL DEFAULT 0,
  r_human               REAL,
  priority              REAL    NOT NULL DEFAULT 0,
  tags_json             TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  error_signatures_json TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(error_signatures_json)),
  vec_summary           BLOB,
  vec_action            BLOB,
  share_scope           TEXT,
  share_target          TEXT,
  shared_at             INTEGER,
  turn_id               INTEGER NOT NULL,
  schema_version        INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX IF NOT EXISTS idx_traces_episode_ts   ON traces(episode_id, ts);
CREATE INDEX IF NOT EXISTS idx_traces_session_ts   ON traces(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_traces_priority     ON traces(priority DESC);
CREATE INDEX IF NOT EXISTS idx_traces_abs_value    ON traces(abs(value) DESC);
CREATE INDEX IF NOT EXISTS idx_traces_episode_turn ON traces(episode_id, turn_id, ts);

-- ─── L2 Policies ────────────────────────────────────────────────────────────
-- Status set is the unified candidate/active/archived (was 012). Sharing
-- metadata + edited_at landed in migration 009 and are baked in below.
-- `decision_guidance_json` (V7 §2.4.6) holds the structured
-- `{preference: string[], antiPattern: string[]}` blob the
-- decision-repair pipeline writes whenever the user feedback (or a
-- failure burst) yields concrete prefer/avoid lines. Defaults to
-- `{"preference":[],"antiPattern":[]}` so every read site can deserialise
-- without a null branch.
CREATE TABLE IF NOT EXISTS policies (
  id                       TEXT    PRIMARY KEY,
  title                    TEXT    NOT NULL,
  trigger                  TEXT    NOT NULL,
  procedure                TEXT    NOT NULL,
  verification             TEXT    NOT NULL,
  boundary                 TEXT    NOT NULL,
  support                  INTEGER NOT NULL DEFAULT 0,
  gain                     REAL    NOT NULL DEFAULT 0,
  status                   TEXT    NOT NULL CHECK (status IN ('candidate','active','archived')) DEFAULT 'candidate',
  source_episodes_json     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(source_episodes_json)),
  induced_by               TEXT    NOT NULL DEFAULT '',
  decision_guidance_json   TEXT    NOT NULL DEFAULT '{"preference":[],"antiPattern":[]}'
                                   CHECK (json_valid(decision_guidance_json)),
  vec                      BLOB,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  share_scope              TEXT,
  share_target             TEXT,
  shared_at                INTEGER,
  edited_at                INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_policies_status  ON policies(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_policies_support ON policies(support DESC, gain DESC);

-- Candidate pool for incremental L2 induction (V7 §2.4.1 step 3).
CREATE TABLE IF NOT EXISTS l2_candidate_pool (
  id                      TEXT    PRIMARY KEY,
  policy_id               TEXT REFERENCES policies(id) ON DELETE SET NULL,
  evidence_trace_ids_json TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_trace_ids_json)),
  signature               TEXT    NOT NULL,
  similarity              REAL    NOT NULL DEFAULT 0,
  expires_at              INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_l2_candidate_sig     ON l2_candidate_pool(signature);
CREATE INDEX IF NOT EXISTS idx_l2_candidate_expires ON l2_candidate_pool(expires_at);

-- ─── L3 World-model ─────────────────────────────────────────────────────────
-- Includes structured (ℰ, ℐ, 𝒞) triple, domain tags, confidence, audit
-- trail and lifecycle (active/archived) — all from migrations 003 + 009 +
-- 012 squashed in.
CREATE TABLE IF NOT EXISTS world_model (
  id                   TEXT    PRIMARY KEY,
  title                TEXT    NOT NULL,
  body                 TEXT    NOT NULL,
  policy_ids_json      TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(policy_ids_json)),
  structure_json       TEXT    NOT NULL DEFAULT
    '{"environment":[],"inference":[],"constraints":[]}'
    CHECK (json_valid(structure_json)),
  domain_tags_json     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(domain_tags_json)),
  confidence           REAL    NOT NULL DEFAULT 0.5,
  source_episodes_json TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(source_episodes_json)),
  induced_by           TEXT    NOT NULL DEFAULT '',
  vec                  BLOB,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  share_scope          TEXT,
  share_target         TEXT,
  shared_at            INTEGER,
  edited_at            INTEGER,
  status               TEXT    NOT NULL DEFAULT 'active',
  archived_at          INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_world_updated    ON world_model(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_world_confidence ON world_model(confidence DESC);

-- ─── Skills ─────────────────────────────────────────────────────────────────
-- Status set unified to candidate/active/archived (was 012). version
-- counter (008), share/edit metadata (009), and evidence_anchors_json
-- (014) are all baked in.
CREATE TABLE IF NOT EXISTS skills (
  id                    TEXT    PRIMARY KEY,
  name                  TEXT    NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('candidate','active','archived')) DEFAULT 'candidate',
  invocation_guide      TEXT    NOT NULL,
  procedure_json        TEXT    NOT NULL DEFAULT 'null' CHECK (json_valid(procedure_json)),
  eta                   REAL    NOT NULL DEFAULT 0,
  support               INTEGER NOT NULL DEFAULT 0,
  gain                  REAL    NOT NULL DEFAULT 0,
  trials_attempted      INTEGER NOT NULL DEFAULT 0,
  trials_passed         INTEGER NOT NULL DEFAULT 0,
  source_policies_json  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(source_policies_json)),
  source_world_json     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(source_world_json)),
  evidence_anchors_json TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_anchors_json)),
  vec                   BLOB,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  share_scope           TEXT,
  share_target          TEXT,
  shared_at             INTEGER,
  edited_at             INTEGER
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

CREATE INDEX IF NOT EXISTS idx_feedback_ts      ON feedback(ts DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_trace   ON feedback(trace_id);
CREATE INDEX IF NOT EXISTS idx_feedback_episode ON feedback(episode_id);

-- ─── Decision repair history ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS decision_repairs (
  id                     TEXT    PRIMARY KEY,
  ts                     INTEGER NOT NULL,
  context_hash           TEXT    NOT NULL,
  preference             TEXT    NOT NULL,
  anti_pattern           TEXT    NOT NULL,
  high_value_traces_json TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(high_value_traces_json)),
  low_value_traces_json  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(low_value_traces_json)),
  validated              INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_repairs_ts      ON decision_repairs(ts DESC);
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

CREATE INDEX IF NOT EXISTS idx_audit_ts   ON audit_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_kind ON audit_events(kind, ts DESC);

-- ─── API call log (was migration 007) ───────────────────────────────────────
-- Powers the viewer's Logs page. Append-only; rotation is handled at a
-- higher level if the volume grows big.
CREATE TABLE IF NOT EXISTS api_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name    TEXT    NOT NULL,
  input_json   TEXT    NOT NULL DEFAULT '{}',
  output_json  TEXT    NOT NULL DEFAULT '',
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  success      INTEGER NOT NULL DEFAULT 1,
  called_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_logs_called_at ON api_logs(called_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_tool_time ON api_logs(tool_name, called_at DESC);

-- ─── Generic key-value store ───────────────────────────────────────────────
-- Used for tiny bookkeeping: last_trace_ts, installed_version, hub.last_sync_ts…
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL
) STRICT;

-- ─── FTS5 keyword indexes (was migration 010) ──────────────────────────────
-- Trigram-tokenized FTS5 tables that mirror the traces / skills /
-- world_model bases via INSERT/UPDATE/DELETE triggers. The repos query
-- these tables directly for keyword channel hits and fuse with the
-- vector channels via RRF in the ranker.
--
-- The trigram tokenizer (SQLite ≥ 3.34) treats Latin, CJK and mixed
-- scripts uniformly without depending on whitespace, and turns FTS5
-- MATCH into a substring contains-match for free. 2-char CJK queries
-- that fall below the trigram window have a separate LIKE-pattern
-- channel computed in the repo at query time.

-- Traces FTS
CREATE VIRTUAL TABLE IF NOT EXISTS traces_fts USING fts5(
  trace_id UNINDEXED,
  user_text,
  agent_text,
  summary,
  reflection,
  tags,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS traces_fts_ai AFTER INSERT ON traces BEGIN
  INSERT INTO traces_fts(trace_id, user_text, agent_text, summary, reflection, tags)
  VALUES (
    new.id,
    new.user_text,
    new.agent_text,
    COALESCE(new.summary, ''),
    COALESCE(new.reflection, ''),
    new.tags_json
  );
END;

CREATE TRIGGER IF NOT EXISTS traces_fts_ad AFTER DELETE ON traces BEGIN
  DELETE FROM traces_fts WHERE trace_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS traces_fts_au AFTER UPDATE ON traces BEGIN
  DELETE FROM traces_fts WHERE trace_id = old.id;
  INSERT INTO traces_fts(trace_id, user_text, agent_text, summary, reflection, tags)
  VALUES (
    new.id,
    new.user_text,
    new.agent_text,
    COALESCE(new.summary, ''),
    COALESCE(new.reflection, ''),
    new.tags_json
  );
END;

-- Skills FTS
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  skill_id UNINDEXED,
  name,
  invocation_guide,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS skills_fts_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(skill_id, name, invocation_guide)
  VALUES (new.id, new.name, new.invocation_guide);
END;

CREATE TRIGGER IF NOT EXISTS skills_fts_ad AFTER DELETE ON skills BEGIN
  DELETE FROM skills_fts WHERE skill_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS skills_fts_au AFTER UPDATE ON skills BEGIN
  DELETE FROM skills_fts WHERE skill_id = old.id;
  INSERT INTO skills_fts(skill_id, name, invocation_guide)
  VALUES (new.id, new.name, new.invocation_guide);
END;

-- World models FTS
CREATE VIRTUAL TABLE IF NOT EXISTS world_model_fts USING fts5(
  world_id UNINDEXED,
  title,
  body,
  domain_tags,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS world_model_fts_ai AFTER INSERT ON world_model BEGIN
  INSERT INTO world_model_fts(world_id, title, body, domain_tags)
  VALUES (
    new.id,
    new.title,
    new.body,
    COALESCE(new.domain_tags_json, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS world_model_fts_ad AFTER DELETE ON world_model BEGIN
  DELETE FROM world_model_fts WHERE world_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS world_model_fts_au AFTER UPDATE ON world_model BEGIN
  DELETE FROM world_model_fts WHERE world_id = old.id;
  INSERT INTO world_model_fts(world_id, title, body, domain_tags)
  VALUES (
    new.id,
    new.title,
    new.body,
    COALESCE(new.domain_tags_json, '')
  );
END;
