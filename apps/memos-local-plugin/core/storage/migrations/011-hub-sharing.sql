-- Optional team sharing runtime.
--
-- These tables are intentionally separate from the local L1/L2/L3/Skill
-- tables. Hub content is a network-facing projection, not a merge of local
-- private databases.

CREATE TABLE IF NOT EXISTS hub_users (
  id                  TEXT    PRIMARY KEY,
  username            TEXT    NOT NULL,
  device_name         TEXT    NOT NULL DEFAULT '',
  role                TEXT    NOT NULL CHECK (role IN ('admin','member')) DEFAULT 'member',
  status              TEXT    NOT NULL CHECK (status IN ('pending','active','rejected','blocked','left','removed')) DEFAULT 'pending',
  token_hash          TEXT    NOT NULL DEFAULT '',
  identity_key        TEXT    NOT NULL DEFAULT '',
  created_at          INTEGER NOT NULL,
  approved_at         INTEGER,
  rejected_at         INTEGER,
  left_at             INTEGER,
  removed_at          INTEGER,
  last_ip             TEXT    NOT NULL DEFAULT '',
  last_active_at      INTEGER,
  rejoin_requested_at INTEGER
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_users_identity
  ON hub_users(identity_key)
  WHERE identity_key <> '';
CREATE INDEX IF NOT EXISTS idx_hub_users_status ON hub_users(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hub_users_role ON hub_users(role, status);

CREATE TABLE IF NOT EXISTS client_hub_connection (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  hub_url           TEXT    NOT NULL,
  user_id           TEXT    NOT NULL DEFAULT '',
  username          TEXT    NOT NULL DEFAULT '',
  user_token        TEXT    NOT NULL DEFAULT '',
  role              TEXT    NOT NULL DEFAULT 'member',
  connected_at      INTEGER NOT NULL,
  identity_key      TEXT    NOT NULL DEFAULT '',
  last_known_status TEXT    NOT NULL DEFAULT '',
  hub_instance_id   TEXT    NOT NULL DEFAULT ''
) STRICT;

CREATE TABLE IF NOT EXISTS hub_shared_memories (
  id              TEXT    PRIMARY KEY,
  source_trace_id TEXT    NOT NULL,
  source_user_id  TEXT    NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
  source_agent    TEXT    NOT NULL DEFAULT '',
  kind            TEXT    NOT NULL DEFAULT 'trace',
  summary         TEXT    NOT NULL DEFAULT '',
  content         TEXT    NOT NULL DEFAULT '',
  embedding       BLOB,
  embedding_norm2 REAL,
  visible         INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
  deleted_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(source_user_id, source_trace_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_hub_shared_memories_user
  ON hub_shared_memories(source_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hub_shared_memories_updated
  ON hub_shared_memories(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hub_shared_memories_deleted
  ON hub_shared_memories(visible, deleted_at)
  WHERE visible = 0 AND deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS hub_shared_skills (
  id              TEXT    PRIMARY KEY,
  source_skill_id TEXT    NOT NULL,
  source_user_id  TEXT    NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  invocation_guide TEXT   NOT NULL DEFAULT '',
  version         INTEGER NOT NULL DEFAULT 1,
  quality_score   REAL,
  bundle_json     TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(bundle_json)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(source_user_id, source_skill_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_hub_shared_skills_user
  ON hub_shared_skills(source_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hub_shared_skills_updated
  ON hub_shared_skills(updated_at DESC);
