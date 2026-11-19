"""PostgreSQL schema for the project memory Add workflow."""

CREATE_TABLES = """
CREATE TABLE IF NOT EXISTS spaces (
  id                          text PRIMARY KEY,
  project_id                  text NOT NULL,
  space_name                  text NOT NULL,
  instructions                text,
  resource_bindings           jsonb NOT NULL DEFAULT '[]',
  last_formation_at           timestamptz,
  staged_since_last_formation int    NOT NULL DEFAULT 0,
  formation_version           bigint NOT NULL DEFAULT 0,
  cleared_at                  timestamptz,
  create_time                 timestamptz NOT NULL DEFAULT now(),
  update_time                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id)
);
CREATE INDEX IF NOT EXISTS spaces_project_idx ON spaces (project_id);


CREATE TABLE IF NOT EXISTS domains (
  id          text PRIMARY KEY,
  space_id    text NOT NULL REFERENCES spaces ON DELETE CASCADE,
  domain      text NOT NULL,
  description text NOT NULL DEFAULT '',
  create_time timestamptz NOT NULL DEFAULT now(),
  update_time timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, domain),
  UNIQUE (space_id, id)
);


CREATE TABLE IF NOT EXISTS topics (
  id                    text PRIMARY KEY,
  space_id              text NOT NULL REFERENCES spaces ON DELETE CASCADE,
  domain_id             text NOT NULL,
  topic_name            text NOT NULL,
  topic_summary         text NOT NULL,
  topic_description     text NOT NULL,
  decisions             jsonb NOT NULL DEFAULT '[]',
  experiences           jsonb NOT NULL DEFAULT '[]',
  timeline              jsonb NOT NULL DEFAULT '[]',
  sources               jsonb NOT NULL DEFAULT '[]',
  anchors               jsonb NOT NULL DEFAULT '[]',
  anchor_keys           text[] NOT NULL DEFAULT '{{}}',
  version               bigint NOT NULL DEFAULT 1,
  embedding             vector({dimension}),
  embedding_model_id    text,
  search_tsv            tsvector,
  created_by_episode_id text,
  last_commit_key       text,
  create_time           timestamptz NOT NULL,
  update_time           timestamptz NOT NULL,
  committed_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, id),
  FOREIGN KEY (space_id, domain_id) REFERENCES domains (space_id, id)
);
CREATE INDEX IF NOT EXISTS topics_space_updated_idx ON topics (space_id, update_time DESC, id);
CREATE INDEX IF NOT EXISTS topics_space_domain_idx  ON topics (space_id, domain_id);
CREATE INDEX IF NOT EXISTS topics_fts_idx           ON topics USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS topics_anchor_keys_idx   ON topics USING gin (anchor_keys);
CREATE INDEX IF NOT EXISTS topics_sources_idx       ON topics USING gin (sources jsonb_path_ops);


CREATE TABLE IF NOT EXISTS topic_items (
  id                 text PRIMARY KEY,
  topic_id           text NOT NULL,
  space_id           text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('decision','experience','timeline')),
  content            text NOT NULL,
  time               timestamptz NOT NULL,
  user_ids           text[] NOT NULL DEFAULT '{{}}',
  topic_version      bigint NOT NULL,
  search_tsv         tsvector,
  embedding          vector({dimension}),
  embedding_model_id text,
  FOREIGN KEY (space_id, topic_id) REFERENCES topics (space_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS topic_items_topic_idx     ON topic_items (topic_id);
CREATE INDEX IF NOT EXISTS topic_items_space_idx     ON topic_items (space_id, kind, time DESC);
CREATE INDEX IF NOT EXISTS topic_items_fts_idx       ON topic_items USING gin (search_tsv);


CREATE TABLE IF NOT EXISTS messages (
  project_id       text NOT NULL,
  conversation_key text NOT NULL,
  message_id       text NOT NULL,
  conversation_id  text,
  turn_id          text NOT NULL,
  turn_seq         bigint NOT NULL,
  msg_seq          int    NOT NULL,
  role             text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  role_id          text,
  role_name        text,
  content          text NOT NULL,
  tool_calls       jsonb,
  tool_call_id     text,
  experience_notes jsonb,
  chat_time        timestamptz NOT NULL,
  accepted_at      timestamptz NOT NULL,
  task_id          text NOT NULL,
  user_id          text NOT NULL,
  agent_id         jsonb,
  raw_sha256       text,
  content_sha256   text NOT NULL,
  PRIMARY KEY (project_id, conversation_key, message_id)
);
CREATE INDEX IF NOT EXISTS messages_turn_order_idx
  ON messages (project_id, conversation_key, turn_seq, msg_seq);
CREATE INDEX IF NOT EXISTS messages_turn_idx ON messages (project_id, conversation_key, turn_id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS raw_sha256 text;


CREATE TABLE IF NOT EXISTS episodes (
  id                  text PRIMARY KEY,
  space_id            text NOT NULL REFERENCES spaces ON DELETE CASCADE,
  project_id          text NOT NULL,
  conversation_key    text NOT NULL,
  conversation_id     text,
  user_id             text NOT NULL,
  domains             text[] NOT NULL,
  previous_episode_id text,

  state               text NOT NULL CHECK (state IN ('open','closed','extracting','extracted')),
  close_reason        text CHECK (close_reason IN ('task_boundary','idle','turn_count','max_wait','volume','no_conversation')),
  opened_at           timestamptz NOT NULL,
  last_turn_at        timestamptz NOT NULL,
  idle_due_at         timestamptz,
  max_wait_due_at     timestamptz,
  closed_at           timestamptz,
  dispatched_at       timestamptz,
  suspected_boundary_turn_ids text[] NOT NULL DEFAULT '{{}}',

  extract_status      text CHECK (extract_status IN ('drafted','skipped','failed')),
  episode_summary     text,
  drafts              jsonb NOT NULL DEFAULT '[]',
  anchors             jsonb NOT NULL DEFAULT '[]',
  anchor_keys         text[] NOT NULL DEFAULT '{{}}',
  extracted_at        timestamptz,

  stage               text NOT NULL CHECK (stage IN ('episode_open','extracting','organizing_queued','organizing',
                                                     'awaiting_merge','committing','retry_wait','done')),
  attempt             int  NOT NULL DEFAULT 0,
  organize_result     jsonb,
  commit_key          text UNIQUE,
  outcome             text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','committed','staged','skipped','failed')),
  result              jsonb,
  created_topic_ids   text[] NOT NULL DEFAULT '{{}}',
  next_retry_at       timestamptz,
  error               jsonb,
  last_error          jsonb,
  warnings            jsonb NOT NULL DEFAULT '[]',

  staged_status       text CHECK (staged_status IN ('active','moved','archived','long_unassigned')),
  staged_domain_id    text,
  staged_reason       text,
  staged_at           timestamptz,
  staged_attempts     int  NOT NULL DEFAULT 0,
  moved_to_topic_id   text,
  staged_tsv          tsvector,
  staged_embedding    vector({dimension}),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, space_id, conversation_key, id),
  FOREIGN KEY (project_id, space_id) REFERENCES spaces (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, space_id, conversation_key, previous_episode_id)
    REFERENCES episodes (project_id, space_id, conversation_key, id),
  FOREIGN KEY (space_id, staged_domain_id) REFERENCES domains (space_id, id),
  CHECK ((state = 'open') = (closed_at IS NULL)),
  CHECK ((staged_status = 'moved') = (moved_to_topic_id IS NOT NULL)),
  CHECK ((staged_status IS NULL) = (staged_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS episodes_one_open        ON episodes (space_id, conversation_key) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS episodes_previous_idx           ON episodes (space_id, conversation_key, closed_at DESC) WHERE state <> 'open';
CREATE INDEX IF NOT EXISTS episodes_due_idx                ON episodes (LEAST(idle_due_at, max_wait_due_at)) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS episodes_undispatched_idx       ON episodes (dispatched_at NULLS FIRST) WHERE state = 'closed';
CREATE INDEX IF NOT EXISTS episodes_retry_idx              ON episodes (next_retry_at) WHERE stage = 'retry_wait';
CREATE INDEX IF NOT EXISTS episodes_merge_wait_idx         ON episodes (updated_at) WHERE stage = 'awaiting_merge';
CREATE INDEX IF NOT EXISTS episodes_staged_active_idx      ON episodes (space_id, staged_at DESC) WHERE staged_status = 'active';
CREATE INDEX IF NOT EXISTS episodes_staged_fts_idx         ON episodes USING gin (staged_tsv) WHERE staged_status = 'active';
CREATE INDEX IF NOT EXISTS episodes_anchor_keys_idx        ON episodes USING gin (anchor_keys);


CREATE TABLE IF NOT EXISTS episode_turns (
  space_id         text NOT NULL,
  conversation_key text NOT NULL,
  turn_id          text NOT NULL,
  project_id       text NOT NULL,
  episode_id       text NOT NULL,
  turn_seq         int  NOT NULL,
  message_count    int  NOT NULL,
  task_id          text NOT NULL,
  user_id          text NOT NULL,
  agent_id         jsonb,
  chat_time        timestamptz NOT NULL,
  accepted_at      timestamptz NOT NULL,
  PRIMARY KEY (space_id, conversation_key, turn_id),
  FOREIGN KEY (project_id, space_id, conversation_key, episode_id)
    REFERENCES episodes (project_id, space_id, conversation_key, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, conversation_key, turn_id) REFERENCES messages (project_id, conversation_key, message_id)
);
CREATE INDEX IF NOT EXISTS episode_turns_task_idx    ON episode_turns (project_id, task_id);
CREATE INDEX IF NOT EXISTS episode_turns_episode_idx ON episode_turns (episode_id, turn_seq);
"""

CREATE_VECTOR_INDEXES = """
CREATE INDEX IF NOT EXISTS topics_embedding_idx
  ON topics USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS topic_items_embedding_idx
  ON topic_items USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS episodes_staged_embedding_idx
  ON episodes USING hnsw (staged_embedding vector_cosine_ops) WHERE staged_status = 'active';
"""
