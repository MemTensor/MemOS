-- Add keyword retrieval for L2 policies / feedback-derived experiences.

CREATE VIRTUAL TABLE IF NOT EXISTS policies_fts USING fts5(
  policy_id UNINDEXED,
  title,
  trigger,
  procedure,
  verification,
  boundary,
  guidance,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS policies_fts_ai AFTER INSERT ON policies BEGIN
  INSERT INTO policies_fts(policy_id, title, trigger, procedure, verification, boundary, guidance)
  VALUES (
    new.id,
    new.title,
    new.trigger,
    new.procedure,
    new.verification,
    new.boundary,
    COALESCE(new.decision_guidance_json, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS policies_fts_ad AFTER DELETE ON policies BEGIN
  DELETE FROM policies_fts WHERE policy_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS policies_fts_au AFTER UPDATE ON policies BEGIN
  DELETE FROM policies_fts WHERE policy_id = old.id;
  INSERT INTO policies_fts(policy_id, title, trigger, procedure, verification, boundary, guidance)
  VALUES (
    new.id,
    new.title,
    new.trigger,
    new.procedure,
    new.verification,
    new.boundary,
    COALESCE(new.decision_guidance_json, '')
  );
END;

INSERT INTO policies_fts(policy_id, title, trigger, procedure, verification, boundary, guidance)
SELECT id,
       title,
       trigger,
       procedure,
       verification,
       boundary,
       COALESCE(decision_guidance_json, '')
  FROM policies
 WHERE id NOT IN (SELECT policy_id FROM policies_fts);
