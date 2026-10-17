-- Repair keyword retrieval for skills on legacy databases.

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

DELETE FROM skills_fts;
INSERT INTO skills_fts(skill_id, name, invocation_guide)
SELECT id, name, invocation_guide FROM skills;
