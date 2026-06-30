CREATE TABLE IF NOT EXISTS skill_trials (
  id            TEXT    PRIMARY KEY,
  owner_agent_kind TEXT NOT NULL DEFAULT 'unknown',
  owner_profile_id TEXT NOT NULL DEFAULT 'default',
  owner_workspace_id TEXT,
  skill_id      TEXT    NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  session_id    TEXT    REFERENCES sessions(id) ON DELETE SET NULL,
  episode_id    TEXT    NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  trace_id      TEXT    REFERENCES traces(id) ON DELETE SET NULL,
  turn_id       INTEGER,
  tool_call_id  TEXT,
  status        TEXT    NOT NULL CHECK (status IN ('pending','pass','fail','unknown')) DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  evidence_json TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_trials_pending_episode_skill
  ON skill_trials(owner_agent_kind, owner_profile_id, skill_id, episode_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_skill_trials_owner
  ON skill_trials(owner_agent_kind, owner_profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_trials_episode_status
  ON skill_trials(episode_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_trials_skill_status
  ON skill_trials(skill_id, status, created_at DESC);
