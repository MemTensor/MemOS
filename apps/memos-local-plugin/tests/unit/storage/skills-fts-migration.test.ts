import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultMigrationsDir, runMigrations } from "../../../core/storage/migrator.js";
import { makeTmpDb } from "../../helpers/tmp-db.js";

describe("storage/skills-fts-migration", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("repairs legacy skill indexing and keeps the index synchronized", () => {
    const { db, cleanup } = makeTmpDb();
    cleanups.push(cleanup);
    db.exec(`
      DROP TRIGGER skills_fts_ai;
      DROP TRIGGER skills_fts_ad;
      DROP TRIGGER skills_fts_au;
      DELETE FROM skills_fts;
      INSERT INTO skills (id, name, invocation_guide, created_at, updated_at)
      VALUES ('legacy', 'Legacy deployment', 'Deploy a service safely', 1, 1);
    `);
    const indexed = () => db.prepare(`SELECT skill_id, name, invocation_guide FROM skills_fts ORDER BY skill_id`).all();
    expect(indexed()).toEqual([]);

    const sql = fs.readFileSync(path.join(defaultMigrationsDir(), "020-skills-fts.sql"), "utf8");
    db.tx(() => db.exec(sql));

    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'skills' ORDER BY name`).all()).toEqual([
      { name: "skills_fts_ad" },
      { name: "skills_fts_ai" },
      { name: "skills_fts_au" },
    ]);
    expect(indexed()).toEqual([
      { skill_id: "legacy", name: "Legacy deployment", invocation_guide: "Deploy a service safely" },
    ]);

    db.exec(`INSERT INTO skills (id, name, invocation_guide, created_at, updated_at)
      VALUES ('new', 'Database recovery', 'Restore a database backup', 2, 2)`);
    expect(indexed()).toHaveLength(2);
    expect(db.prepare(`SELECT skill_id FROM skills_fts WHERE skills_fts MATCH '"tabase"'`).all()).toEqual([
      { skill_id: "new" },
    ]);
    expect(db.prepare(`SELECT skill_id FROM skills_fts WHERE skills_fts MATCH '"safely"'`).all()).toEqual([
      { skill_id: "legacy" },
    ]);

    // Replaying the repair must not duplicate already indexed skills.
    const before = indexed();
    db.tx(() => db.exec(sql));
    expect(indexed()).toEqual(before);

    db.exec(`UPDATE skills SET name = 'Archive cleanup', invocation_guide = 'Remove old archives' WHERE id = 'new'`);
    expect(db.prepare(`SELECT skill_id FROM skills_fts WHERE skills_fts MATCH '"tabase"'`).all()).toEqual([]);
    expect(db.prepare(`SELECT skill_id FROM skills_fts WHERE skills_fts MATCH '"archives"'`).all()).toEqual([
      { skill_id: "new" },
    ]);
    db.exec(`DELETE FROM skills WHERE id = 'new'`);
    expect(indexed()).toEqual([before[0]]);
  });

  it("fully rebuilds a drifted index from the current skills", () => {
    const { db, cleanup } = makeTmpDb();
    cleanups.push(cleanup);
    db.exec(`
      INSERT INTO skills (id, name, invocation_guide, created_at, updated_at)
      VALUES ('stale', 'Current deployment', 'Deploy the current service', 1, 1),
             ('missing', 'Database recovery', 'Restore a database backup', 2, 2);
      DELETE FROM skills_fts;
      INSERT INTO skills_fts (skill_id, name, invocation_guide)
      VALUES ('stale', 'Obsolete deployment', 'Follow the retired procedure'),
             ('removed', 'Removed skill', 'This skill no longer exists'),
             (NULL, 'Invalid skill', 'This row has no skill id');
    `);
    expect(db.prepare(`SELECT skill_id FROM skills_fts WHERE skills_fts MATCH '"obsolete"'`).all()).toEqual([
      { skill_id: "stale" },
    ]);

    const sql = fs.readFileSync(path.join(defaultMigrationsDir(), "020-skills-fts.sql"), "utf8");
    db.tx(() => db.exec(sql));

    expect(db.prepare(`SELECT skill_id, name, invocation_guide FROM skills_fts ORDER BY skill_id`).all()).toEqual(
      db.prepare(`SELECT id AS skill_id, name, invocation_guide FROM skills ORDER BY id`).all(),
    );
    expect(db.prepare(`SELECT skill_id FROM skills_fts WHERE skills_fts MATCH '"obsolete" OR "retired"'`).all()).toEqual([]);
  });

  it.each([
    { drift: "a missing invocation_guide column", columns: "skill_id UNINDEXED, name" },
    { drift: "the wrong tokenizer", columns: "skill_id UNINDEXED, name, invocation_guide" },
  ])("repairs a legacy definition with $drift", ({ columns }) => {
    const { db, cleanup } = makeTmpDb();
    cleanups.push(cleanup);
    db.exec(`
      INSERT INTO skills (id, name, invocation_guide, created_at, updated_at)
      VALUES ('legacy', 'Current deployment', 'Deploy the current service', 1, 1),
             ('missing', 'Database recovery', 'Restore a database backup', 2, 2);
      DROP TRIGGER skills_fts_ai;
      DROP TRIGGER skills_fts_ad;
      DROP TRIGGER skills_fts_au;
      DROP TABLE skills_fts;
      CREATE VIRTUAL TABLE skills_fts USING fts5(${columns}, tokenize = 'unicode61');
      INSERT INTO skills_fts (skill_id, name)
      VALUES ('legacy', 'Obsolete deployment'), ('removed', 'Removed skill');
      CREATE TRIGGER skills_fts_ai AFTER INSERT ON skills BEGIN
        INSERT INTO skills_fts(skill_id, name) VALUES (new.id, new.name);
      END;
      CREATE TRIGGER skills_fts_ad AFTER DELETE ON skills BEGIN
        DELETE FROM skills_fts WHERE skill_id = old.id;
      END;
      CREATE TRIGGER skills_fts_au AFTER UPDATE ON skills BEGIN
        DELETE FROM skills_fts WHERE skill_id = old.id;
        INSERT INTO skills_fts(skill_id, name) VALUES (new.id, new.name);
      END;
      DELETE FROM schema_migrations WHERE version = 20;
    `);

    const result = runMigrations(db);
    expect(result.applied.map((migration) => migration.version)).toEqual([20]);
    expect(db.prepare<unknown, { name: string }>(`PRAGMA table_info(skills_fts)`).all().map((column) => column.name)).toEqual([
      "skill_id", "name", "invocation_guide",
    ]);
    expect(db.prepare<unknown, { sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'skills_fts'`).get()!.sql)
      .toMatch(/tokenize\s*=\s*'trigram'/);
    expect(db.prepare(`SELECT skill_id, name, invocation_guide FROM skills_fts ORDER BY skill_id`).all()).toEqual(
      db.prepare(`SELECT id AS skill_id, name, invocation_guide FROM skills ORDER BY id`).all(),
    );
    expect(db.prepare(`SELECT skill_id FROM skills_fts WHERE skills_fts MATCH '"obsolete" OR "removed"'`).all()).toEqual([]);
    expect(db.prepare(`SELECT skill_id FROM skills_fts WHERE skills_fts MATCH '"tabase"'`).all()).toEqual([
      { skill_id: "missing" },
    ]);

    db.exec(`INSERT INTO skills (id, name, invocation_guide, created_at, updated_at)
      VALUES ('new', 'New skill', 'Follow the new procedure', 3, 3)`);
    expect(db.prepare(`SELECT invocation_guide FROM skills_fts WHERE skill_id = 'new'`).get()).toEqual({
      invocation_guide: "Follow the new procedure",
    });
    db.exec(`UPDATE skills SET invocation_guide = 'Follow the updated procedure' WHERE id = 'new'`);
    expect(db.prepare(`SELECT invocation_guide FROM skills_fts WHERE skill_id = 'new'`).get()).toEqual({
      invocation_guide: "Follow the updated procedure",
    });
  });

  it("does not rewrite the index when only non-indexed skill columns change", () => {
    const { db, cleanup } = makeTmpDb();
    cleanups.push(cleanup);
    db.exec(`INSERT INTO skills (id, name, invocation_guide, created_at, updated_at)
      VALUES ('legacy', 'Legacy deployment', 'Deploy a service safely', 1, 1)`);
    const totalChanges = () => db.prepare<unknown, { total: number }>(`SELECT total_changes() AS total`).get()!.total;

    for (const update of [
      "usage_count = usage_count + 1, last_used_at = 2",
      "vec = NULL",
      "status = 'archived'",
    ]) {
      const before = totalChanges();
      db.exec(`UPDATE skills SET ${update} WHERE id = 'legacy'`);
      // Only the skills row should be written; FTS shadow tables stay untouched.
      expect(totalChanges() - before).toBe(1);
    }
  });

  it("preserves indexed data on a fresh database with an already indexed skill", () => {
    const { db, cleanup } = makeTmpDb();
    cleanups.push(cleanup);
    db.exec(`INSERT INTO skills (id, name, invocation_guide, created_at, updated_at)
      VALUES ('fresh', 'Fresh skill', 'Use a fresh database', 1, 1)`);
    const before = db.prepare(`SELECT * FROM skills_fts`).all();
    expect(before).toHaveLength(1);
    db.tx(() => db.exec(fs.readFileSync(path.join(defaultMigrationsDir(), "020-skills-fts.sql"), "utf8")));
    expect(db.prepare(`SELECT * FROM skills_fts`).all()).toEqual(before);
  });
});
