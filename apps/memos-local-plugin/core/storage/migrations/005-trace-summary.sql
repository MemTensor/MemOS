-- Migration 005 — add `summary` column to `traces`
-- (parity with `memos-local-openclaw`'s `chunks.summary` field).
--
-- Why: the V7 capture pipeline originally stored the raw `user_text`
-- and `agent_text`, then embedded `user_text` as `vec_summary`. That
-- works for retrieval, but the viewer's Memories panel ends up showing
-- ugly raw conversation snippets (including tool-call echoes,
-- timestamps, system prompts). The legacy plugin displayed a short
-- LLM-generated summary instead — we restore the same affordance here.
--
-- The column is nullable and defaults to `NULL` so existing rows stay
-- valid. Capture writes a non-null string going forward; retrieval /
-- viewer fall back to `user_text` when `summary` is null.
--
-- Indexing: no dedicated index. `summary` is read only alongside the
-- full row (getById / list), never used as a search key.

ALTER TABLE traces ADD COLUMN summary TEXT;
