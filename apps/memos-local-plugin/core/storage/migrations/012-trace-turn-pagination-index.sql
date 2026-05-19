-- Speed up Memories pagination after large imports.
--
-- The Memories page groups L1 traces by (episode_id, turn_id) and orders
-- those groups by the newest trace timestamp. Large imports can push the
-- trace table into the tens of thousands of rows, so keep a covering index
-- for the grouped list path in addition to the episode-local ordering index.

CREATE INDEX IF NOT EXISTS idx_traces_turn_page
  ON traces(owner_agent_kind, owner_profile_id, episode_id, turn_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_traces_turn_recent
  ON traces(episode_id, turn_id, ts DESC);
