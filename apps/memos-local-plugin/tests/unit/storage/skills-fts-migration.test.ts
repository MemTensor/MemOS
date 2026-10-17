import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultMigrationsDir } from "../../../core/storage/migrator.js";
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

  it("is a no-op on a fresh database with an already indexed skill", () => {
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
