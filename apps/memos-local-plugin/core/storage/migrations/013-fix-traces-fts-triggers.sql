-- Rebuild traces_fts and its triggers after the a054c9b8 dedup inadvertently
-- introduced two bugs:
--
--   1. The FTS column was renamed from `trace_id` to `id`, breaking the
--      `JOIN traces t ON t.id = f.trace_id` in repos/traces.ts.
--   2. The UPDATE trigger used `INSERT INTO traces_fts(traces_fts, ...) VALUES('delete', ...)`
--      — the FTS5 special 'delete' command — which only works for external-content
--      or contentless tables. On a regular FTS5 table it throws "SQL logic error",
--      causing every traces UPDATE (including score writes) to fail silently.
--
-- Fix: drop and rebuild the FTS table with the canonical `trace_id` column
-- and correct direct-DELETE trigger syntax, matching the original 001-initial.sql
-- intent and the TS query in core/storage/repos/traces.ts.

DROP TRIGGER IF EXISTS traces_fts_ai;
DROP TRIGGER IF EXISTS traces_fts_ad;
DROP TRIGGER IF EXISTS traces_fts_au;
DROP TABLE   IF EXISTS traces_fts;

CREATE VIRTUAL TABLE traces_fts USING fts5(
  trace_id UNINDEXED,
  user_text,
  agent_text,
  summary,
  reflection,
  tags,
  tokenize = 'trigram'
);

INSERT INTO traces_fts(rowid, trace_id, user_text, agent_text, summary, reflection, tags)
SELECT rowid, id,
       COALESCE(user_text,  ''),
       COALESCE(agent_text, ''),
       COALESCE(summary,    ''),
       COALESCE(reflection, ''),
       COALESCE(tags_json,  '')
FROM traces;

CREATE TRIGGER traces_fts_ai AFTER INSERT ON traces BEGIN
  INSERT INTO traces_fts(rowid, trace_id, user_text, agent_text, summary, reflection, tags)
  VALUES (new.rowid, new.id, new.user_text, new.agent_text,
          COALESCE(new.summary,''), COALESCE(new.reflection,''), new.tags_json);
END;

CREATE TRIGGER traces_fts_ad AFTER DELETE ON traces BEGIN
  DELETE FROM traces_fts WHERE trace_id = old.id;
END;

CREATE TRIGGER traces_fts_au AFTER UPDATE ON traces BEGIN
  DELETE FROM traces_fts WHERE trace_id = old.id;
  INSERT INTO traces_fts(rowid, trace_id, user_text, agent_text, summary, reflection, tags)
  VALUES (new.rowid, new.id, new.user_text, new.agent_text,
          COALESCE(new.summary,''), COALESCE(new.reflection,''), new.tags_json);
END;
