-- Migration 003 — extend `world_model` with structured (E, I, C) +
-- confidence + domain tag columns (V7 §1.1 / §2.4.1 L3 世界模型).
--
-- V7 defines L3 as f^(3) = (ℰ, ℐ, C, {f^(2)}):
--   ℰ (environment topology)  — "what lives where"
--   ℐ (inference rules)       — "how the env responds"
--   C (constraints/taboos)    — "what you must not do"
--
-- We keep `body` as the rendered markdown string (used for prompts,
-- viewer, and embedding), and add:
--   structure_json  — the V7 triple as structured JSON {E,I,C}
--   domain_tags     — JSON array of domain tags for tier-3 retrieval
--   confidence      — L3 reliability, updated via user feedback
--   source_episodes_json — audit trail (which episodes contributed)
--   induced_by      — prompt id/version responsible for this abstraction
--
-- All additions default so existing rows remain valid. No FK on
-- policy_ids_json — policies are soft-referenced (policies can retire
-- without invalidating a world model; an orphan world model is fine to
-- keep for audit and gets re-scored on next abstraction run).

ALTER TABLE world_model ADD COLUMN structure_json TEXT NOT NULL DEFAULT
  '{"environment":[],"inference":[],"constraints":[]}'
  CHECK (json_valid(structure_json));

ALTER TABLE world_model ADD COLUMN domain_tags_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(domain_tags_json));

ALTER TABLE world_model ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;

ALTER TABLE world_model ADD COLUMN source_episodes_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(source_episodes_json));

ALTER TABLE world_model ADD COLUMN induced_by TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_world_confidence ON world_model(confidence DESC);
