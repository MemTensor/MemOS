CREATE TABLE IF NOT EXISTS episode_policy_injections (
  episode_id  TEXT    NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  policy_id   TEXT    NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  source      TEXT,
  injected_at INTEGER NOT NULL,
  PRIMARY KEY (episode_id, policy_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_epi_policy ON episode_policy_injections(policy_id, injected_at DESC);
