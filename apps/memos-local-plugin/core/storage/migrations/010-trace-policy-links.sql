CREATE TABLE IF NOT EXISTS trace_policy_links (
  trace_id   TEXT    NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  policy_id  TEXT    NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  episode_id TEXT    NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (trace_id, policy_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tpl_policy ON trace_policy_links(policy_id);
CREATE INDEX IF NOT EXISTS idx_tpl_episode ON trace_policy_links(episode_id);
