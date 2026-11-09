-- Speed up the health-check model-status lookup.
--
-- After #2380 `findLatestModelStatus()` filters `api_logs` rows by
-- `json_extract(output_json, ...)` so the query is not bounded by any
-- top-N window. Without a functional index that is a full-table scan on
-- every /health poll, and `api_logs` grows to ~10k rows on busy installs.
--
-- The partial functional index below covers exactly the rows the query
-- reads (`tool_name = 'system_model_status'`, a small fraction of the
-- table) and matches the query's filter + ORDER BY shape, so SQLite's
-- planner can turn the scan into an index seek. Functional indexes have
-- been supported since SQLite 3.9; the plugin ships with better-sqlite3
-- v12 which bundles a recent build (>= 3.45).

CREATE INDEX IF NOT EXISTS idx_api_logs_model_status
  ON api_logs (
    json_extract(output_json, '$.role'),
    json_extract(output_json, '$.provider'),
    json_extract(output_json, '$.model'),
    called_at DESC,
    id DESC
  )
  WHERE tool_name = 'system_model_status';
