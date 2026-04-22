-- Migration 010 — keyword-channel FTS5 indexes (trigram tokenizer).
--
-- Motivation
-- ──────────
-- Pure-cosine retrieval over-matches on topic-level surface similarity:
-- any "Python pytest" query pulls every Python-tagged trace ever
-- captured. Legacy `memos-local-openclaw` solved this with a FTS5
-- + pattern channel ranked alongside vectors via RRF — we restore the
-- same affordance here.
--
-- Tokenizer choice
-- ───────────────
-- `tokenize='trigram'` (SQLite ≥ 3.34) splits text into 3-character
-- sliding windows. Two payoffs:
--   1. Works for English, CJK, mixed scripts uniformly — no whitespace
--      assumption (unicode61 fails on Chinese; porter ignores CJK).
--   2. Substring queries become contains-matches automatically (FTS5
--      MATCH "docker" hits "dockerfile", "docker-compose", "in docker").
-- Trade-off: index size ≈ 3× the source text. Acceptable at our scale
-- (≤ 10⁶ traces ≈ 100 MB FTS index).
--
-- For 2-char CJK queries that fall below the trigram window
-- (e.g. "唐波"), the repos add a LIKE-based bigram channel — see
-- `tracesRepo.searchByPattern`. The bigram channel is computed at
-- query time, no extra index needed.
--
-- Per-tier tables
-- ───────────────
-- We keep one FTS table per tier so each channel can be tuned
-- independently and triggers stay surgical:
--   - `traces_fts`       — user_text, agent_text, summary, reflection, tags
--   - `skills_fts`       — name, invocation_guide
--   - `world_model_fts`  — title, body, domain_tags
--
-- Triggers
-- ───────
-- After INSERT / UPDATE / DELETE on each base table, mirror the change
-- into the corresponding FTS index. We use the trace/skill/world id as
-- an UNINDEXED column so we can `SELECT trace_id FROM traces_fts WHERE
-- traces_fts MATCH ? ORDER BY rank LIMIT ?` and join back to the row.

-- ─── Traces ────────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS traces_fts USING fts5(
  trace_id UNINDEXED,
  user_text,
  agent_text,
  summary,
  reflection,
  tags,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS traces_fts_ai AFTER INSERT ON traces BEGIN
  INSERT INTO traces_fts(trace_id, user_text, agent_text, summary, reflection, tags)
  VALUES (
    new.id,
    new.user_text,
    new.agent_text,
    COALESCE(new.summary, ''),
    COALESCE(new.reflection, ''),
    new.tags_json
  );
END;

CREATE TRIGGER IF NOT EXISTS traces_fts_ad AFTER DELETE ON traces BEGIN
  DELETE FROM traces_fts WHERE trace_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS traces_fts_au AFTER UPDATE ON traces BEGIN
  DELETE FROM traces_fts WHERE trace_id = old.id;
  INSERT INTO traces_fts(trace_id, user_text, agent_text, summary, reflection, tags)
  VALUES (
    new.id,
    new.user_text,
    new.agent_text,
    COALESCE(new.summary, ''),
    COALESCE(new.reflection, ''),
    new.tags_json
  );
END;

-- Backfill (idempotent — guarded by NOT EXISTS subquery on trace_id).
INSERT INTO traces_fts(trace_id, user_text, agent_text, summary, reflection, tags)
SELECT id, user_text, agent_text,
       COALESCE(summary, ''), COALESCE(reflection, ''), tags_json
FROM traces
WHERE id NOT IN (SELECT trace_id FROM traces_fts);

-- ─── Skills ────────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  skill_id UNINDEXED,
  name,
  invocation_guide,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS skills_fts_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(skill_id, name, invocation_guide)
  VALUES (new.id, new.name, new.invocation_guide);
END;

CREATE TRIGGER IF NOT EXISTS skills_fts_ad AFTER DELETE ON skills BEGIN
  DELETE FROM skills_fts WHERE skill_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS skills_fts_au AFTER UPDATE ON skills BEGIN
  DELETE FROM skills_fts WHERE skill_id = old.id;
  INSERT INTO skills_fts(skill_id, name, invocation_guide)
  VALUES (new.id, new.name, new.invocation_guide);
END;

INSERT INTO skills_fts(skill_id, name, invocation_guide)
SELECT id, name, invocation_guide FROM skills
WHERE id NOT IN (SELECT skill_id FROM skills_fts);

-- ─── World models ─────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS world_model_fts USING fts5(
  world_id UNINDEXED,
  title,
  body,
  domain_tags,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS world_model_fts_ai AFTER INSERT ON world_model BEGIN
  INSERT INTO world_model_fts(world_id, title, body, domain_tags)
  VALUES (
    new.id,
    new.title,
    new.body,
    COALESCE(new.domain_tags_json, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS world_model_fts_ad AFTER DELETE ON world_model BEGIN
  DELETE FROM world_model_fts WHERE world_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS world_model_fts_au AFTER UPDATE ON world_model BEGIN
  DELETE FROM world_model_fts WHERE world_id = old.id;
  INSERT INTO world_model_fts(world_id, title, body, domain_tags)
  VALUES (
    new.id,
    new.title,
    new.body,
    COALESCE(new.domain_tags_json, '')
  );
END;

INSERT INTO world_model_fts(world_id, title, body, domain_tags)
SELECT id, title, body, COALESCE(domain_tags_json, '') FROM world_model
WHERE id NOT IN (SELECT world_id FROM world_model_fts);
