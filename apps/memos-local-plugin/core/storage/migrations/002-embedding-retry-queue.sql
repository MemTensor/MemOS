-- Persistent compensation queue for failed embedding writes.

CREATE TABLE IF NOT EXISTS embedding_retry_queue (
  id              TEXT    PRIMARY KEY,
  target_kind     TEXT    NOT NULL CHECK (target_kind IN ('trace','policy','world_model','skill')),
  target_id       TEXT    NOT NULL,
  vector_field    TEXT    NOT NULL CHECK (vector_field IN ('vec_summary','vec_action','vec')),
  source_text     TEXT    NOT NULL,
  embed_role      TEXT    NOT NULL CHECK (embed_role IN ('document','query')) DEFAULT 'document',
  status          TEXT    NOT NULL CHECK (status IN ('pending','in_progress','failed','succeeded')) DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 6,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (target_kind, target_id, vector_field)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_embedding_retry_due
  ON embedding_retry_queue(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_embedding_retry_target
  ON embedding_retry_queue(target_kind, target_id);
