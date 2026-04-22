-- Migration 007 — dedicated `api_logs` table.
--
-- We already have unstructured log streams (app / error / audit / etc.)
-- but the viewer's Logs page needs a structured, queryable trail of
-- the two operations the user cares about: `memory_search` and
-- `memory_add`. Mirrors `memos-local-openclaw`'s `api_logs` table.
--
-- Schema:
--   id          auto increment primary key
--   tool_name   'memory_search' | 'memory_add' (open string for future)
--   input_json  JSON text — tool params / contextual info
--   output_json TEXT — usually JSON (candidates / filtered / stored),
--               sometimes a plain "stats" summary line + JSON lines.
--               Stored verbatim so the viewer can render whatever
--               shape we stored today without migrations.
--   duration_ms INTEGER — measured at call site.
--   success     0/1 — whether the operation succeeded.
--   called_at   epoch ms — wall-clock of the call.
--
-- Indexes: time-based pagination (most recent first) + optional
-- per-tool filtering. Rows are append-only; rotation is delegated
-- to `logs/retention` at a higher level if the volume grows big.

CREATE TABLE IF NOT EXISTS api_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name    TEXT    NOT NULL,
  input_json   TEXT    NOT NULL DEFAULT '{}',
  output_json  TEXT    NOT NULL DEFAULT '',
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  success      INTEGER NOT NULL DEFAULT 1,
  called_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_logs_called_at
  ON api_logs(called_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_tool_time
  ON api_logs(tool_name, called_at DESC);
