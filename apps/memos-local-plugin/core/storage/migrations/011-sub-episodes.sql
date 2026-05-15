CREATE TABLE IF NOT EXISTS sub_episodes (
  id                     TEXT    PRIMARY KEY,
  episode_id             TEXT    NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  session_id             TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_agent_kind       TEXT    NOT NULL DEFAULT 'unknown',
  owner_profile_id       TEXT    NOT NULL DEFAULT 'default',
  owner_workspace_id     TEXT,
  trace_ids_json         TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(trace_ids_json)),
  start_trace_id         TEXT    NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  end_trace_id           TEXT    NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  start_ts               INTEGER NOT NULL,
  end_ts                 INTEGER NOT NULL,
  local_goal             TEXT    NOT NULL,
  trigger                TEXT    NOT NULL,
  action_chain_json      TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(action_chain_json)),
  observations_json      TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(observations_json)),
  outcome                TEXT    NOT NULL,
  verification           TEXT    NOT NULL,
  failure_mode           TEXT,
  reflection             TEXT,
  alpha                  REAL    NOT NULL DEFAULT 0,
  value                  REAL    NOT NULL DEFAULT 0,
  priority               REAL    NOT NULL DEFAULT 0,
  learnability_score     REAL    NOT NULL DEFAULT 0,
  learnability_reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(learnability_reasons_json)),
  tags_json              TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  error_signatures_json  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(error_signatures_json)),
  completeness           REAL    NOT NULL DEFAULT 0,
  transferability        REAL    NOT NULL DEFAULT 0,
  mean_value             REAL    NOT NULL DEFAULT 0,
  max_value              REAL    NOT NULL DEFAULT 0,
  min_value              REAL    NOT NULL DEFAULT 0,
  polarity               TEXT    NOT NULL DEFAULT 'neutral'
                                 CHECK (polarity IN ('positive','negative','mixed','neutral')),
  summary                TEXT    NOT NULL,
  vec_summary            BLOB,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  meta_json              TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sub_episodes_episode ON sub_episodes(episode_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_sub_episodes_session ON sub_episodes(session_id, start_ts DESC);
CREATE INDEX IF NOT EXISTS idx_sub_episodes_owner ON sub_episodes(owner_agent_kind, owner_profile_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_episodes_value ON sub_episodes(value DESC, priority DESC, learnability_score DESC);

ALTER TABLE l2_candidate_pool ADD COLUMN evidence_sub_episode_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_sub_episode_ids_json));
