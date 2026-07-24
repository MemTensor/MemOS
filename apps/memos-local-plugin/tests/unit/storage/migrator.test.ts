import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDb, runMigrations } from "../../../core/storage/index.js";
import {
  defaultMigrationsDir,
  discoverMigrations,
} from "../../../core/storage/migrator.js";

describe("storage/migrator", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function tmpDb(): { dbPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-mig-"));
    const dbPath = path.join(dir, "m.db");
    return {
      dbPath,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("discovers 001-initial.sql from the shipped migrations dir", () => {
    const files = discoverMigrations(defaultMigrationsDir());
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]!.version).toBe(1);
    expect(files[0]!.name).toBe("initial");
  });

  it("applies migrations once, is idempotent on re-run", () => {
    const { dbPath, cleanup } = tmpDb();
    cleanups.push(cleanup);

    const db = openDb({ filepath: dbPath, agent: "openclaw" });
    try {
      const first = runMigrations(db);
      expect(first.applied.length).toBeGreaterThan(0);
      expect(first.skipped).toBe(0);

      const second = runMigrations(db);
      expect(second.applied.length).toBe(0);
      expect(second.skipped).toBe(first.total);
      expect(db.isReady()).toBe(true);

      // The schema_migrations table lists only what was actually applied.
      const rows = db
        .prepare<unknown, { version: number; name: string }>(
          `SELECT version, name FROM schema_migrations ORDER BY version`,
        )
        .all();
      expect(rows.length).toBe(first.total);
    } finally {
      db.close();
    }
  });

  it("rejects duplicate migration versions in a custom dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-mig-dup-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    fs.writeFileSync(path.join(dir, "001-a.sql"), "SELECT 1;");
    fs.writeFileSync(path.join(dir, "001-b.sql"), "SELECT 1;");

    expect(() => discoverMigrations(dir)).toThrow(/duplicate migration version/);
  });

  it("creates every declared top-level table", () => {
    const { dbPath, cleanup } = tmpDb();
    cleanups.push(cleanup);
    const db = openDb({ filepath: dbPath, agent: "openclaw" });
    try {
      runMigrations(db);
      const tables = db
        .prepare<unknown, { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all()
        .map((r) => r.name);

      for (const required of [
        "audit_events",
        "decision_repairs",
        "episodes",
        "evolution_jobs",
        "feedback",
        "kv",
        "l2_candidate_pool",
        "policies",
        "schema_migrations",
        "sessions",
        "skills",
        "traces",
        "world_model",
      ]) {
        expect(tables).toContain(required);
      }
    } finally {
      db.close();
    }
  });

  it("applies evolution jobs after released migration versions 13-16", () => {
    const { dbPath, cleanup } = tmpDb();
    cleanups.push(cleanup);
    const db = openDb({ filepath: dbPath, agent: "openclaw" });
    try {
      runMigrations(db);
      db.exec(`
        DROP TABLE evolution_jobs;
        DELETE FROM schema_migrations WHERE version = 17;
        INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES
          (13, 'skill-repair-origin', 0),
          (14, 'episode-outcome', 0),
          (15, 'policy-merge-family', 0),
          (16, 'episode-policy-injections', 0);
        INSERT INTO feedback (
          id, ts, channel, polarity, magnitude, rationale, raw_json
        ) VALUES (
          'feedback-before-v17', 1234, 'explicit', 'negative', 0.75,
          'keep me unchanged', '{"source":"old-version"}'
        );
      `);

      const result = runMigrations(db);

      expect(result.applied.map((migration) => migration.version)).toEqual([17]);
      expect(db
        .prepare<unknown, { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='evolution_jobs'`,
        )
        .get()?.name).toBe("evolution_jobs");
      expect(db.prepare<{ id: string }, {
        ts: number;
        channel: string;
        polarity: string;
        magnitude: number;
        rationale: string;
        raw_json: string;
      }>(
        `SELECT ts, channel, polarity, magnitude, rationale, raw_json
           FROM feedback WHERE id=@id`,
      ).get({ id: "feedback-before-v17" })).toEqual({
        ts: 1234,
        channel: "explicit",
        polarity: "negative",
        magnitude: 0.75,
        rationale: "keep me unchanged",
        raw_json: '{"source":"old-version"}',
      });
      expect(db.prepare<unknown, { n: number }>(
        "SELECT COUNT(*) AS n FROM evolution_jobs",
      ).get()?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("lets an older migration set reopen a database that already has v17", () => {
    const { dbPath, cleanup } = tmpDb();
    cleanups.push(cleanup);
    const oldMigrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-mig-old-"));
    cleanups.push(() => fs.rmSync(oldMigrationsDir, { recursive: true, force: true }));
    for (const migration of discoverMigrations(defaultMigrationsDir())) {
      if (migration.version >= 17) continue;
      fs.copyFileSync(
        migration.fullPath,
        path.join(oldMigrationsDir, path.basename(migration.fullPath)),
      );
    }
    const db = openDb({ filepath: dbPath, agent: "openclaw" });
    try {
      runMigrations(db);
      db.exec(`
        INSERT INTO feedback (
          id, ts, channel, polarity, magnitude, rationale, raw_json
        ) VALUES (
          'feedback-survives-downgrade', 2345, 'explicit', 'positive', 1,
          'still readable', '{}'
        );
      `);

      const result = runMigrations(db, oldMigrationsDir);

      expect(result.applied).toHaveLength(0);
      expect(db.prepare<{ id: string }, { rationale: string }>(
        "SELECT rationale FROM feedback WHERE id=@id",
      ).get({ id: "feedback-survives-downgrade" })?.rationale).toBe("still readable");
      expect(db.prepare<{ version: number }, { n: number }>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE version=@version",
      ).get({ version: 17 })?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("treats embedding retry lease migration as satisfied when columns already exist", () => {
    const { dbPath, cleanup } = tmpDb();
    cleanups.push(cleanup);
    const db = openDb({ filepath: dbPath, agent: "openclaw" });
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version     INTEGER PRIMARY KEY,
          name        TEXT    NOT NULL,
          applied_at  INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE embedding_retry_queue (
          id              TEXT    PRIMARY KEY,
          target_kind     TEXT    NOT NULL CHECK (target_kind IN ('trace','policy','world_model','skill')),
          target_id       TEXT    NOT NULL,
          vector_field    TEXT    NOT NULL CHECK (vector_field IN ('vec_summary','vec_action','vec')),
          source_text     TEXT    NOT NULL,
          embed_role      TEXT    NOT NULL CHECK (embed_role IN ('document','query')) DEFAULT 'document',
          status          TEXT    NOT NULL CHECK (status IN ('pending','in_progress','failed','succeeded')) DEFAULT 'pending',
          attempts        INTEGER NOT NULL DEFAULT 0,
          max_attempts    INTEGER NOT NULL DEFAULT 6,
          next_attempt_at INTEGER NOT NULL,
          claimed_by      TEXT,
          lease_until     INTEGER,
          last_error      TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          UNIQUE (target_kind, target_id, vector_field)
        ) STRICT;
        INSERT INTO schema_migrations(version, name, applied_at)
          VALUES (1, 'initial', 0), (2, 'embedding-retry-queue', 0);
      `);

      const result = runMigrations(db);

      expect(result.applied.map((m) => m.version)).toContain(3);
      const columns = db
        .prepare<unknown, { name: string }>(`PRAGMA table_info(embedding_retry_queue)`)
        .all()
        .map((row) => row.name);
      expect(columns.filter((name) => name === "claimed_by")).toHaveLength(1);
      expect(columns.filter((name) => name === "lease_until")).toHaveLength(1);
      expect(db
        .prepare<{ version: number }, { n: number }>(
          `SELECT COUNT(*) AS n FROM schema_migrations WHERE version=@version`,
        )
        .get({ version: 3 })?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("namespace-visibility migration does not rewrite existing NULL share_scope rows (regression #1787)", () => {
    // Regression test for https://github.com/MemTensor/MemOS/issues/1787:
    // The namespace-visibility migration originally issued
    // `UPDATE traces SET share_scope='private' WHERE share_scope IS NULL`
    // against the entire traces table. On databases >500 MB that UPDATE
    // held the bootstrap transaction in CPU-bound row rewriting (re-validating
    // JSON CHECK constraints) for many minutes, manifesting as a bridge hang.
    //
    // The fix removed the bulk UPDATE. This test verifies that rows with
    // NULL share_scope stay NULL after migration (the application layer
    // treats NULL as 'private' via COALESCE).
    const { dbPath, cleanup } = tmpDb();
    cleanups.push(cleanup);
    const db = openDb({ filepath: dbPath, agent: "openclaw" });
    try {
      runMigrations(db);
      // Seed test rows: two with NULL share_scope, two with explicit values.
      db.exec(`
        INSERT INTO sessions (id, agent, started_at, last_seen_at)
          VALUES ('session-1', 'openclaw', 1, 1);
        INSERT INTO episodes (id, session_id, started_at)
          VALUES ('episode-1', 'session-1', 1);
        INSERT INTO traces (
          id, episode_id, session_id, ts, user_text, agent_text,
          value, priority, turn_id, share_scope
        ) VALUES
          ('t-null-a', 'episode-1', 'session-1', 10, 'a', '', 0.0, 0.0, 10, NULL),
          ('t-null-b', 'episode-1', 'session-1', 20, '', 'b', 0.0, 0.0, 20, NULL),
          ('t-private', 'episode-1', 'session-1', 30, 'c', '', 0.0, 0.0, 30, 'private'),
          ('t-public', 'episode-1', 'session-1', 40, '', 'd', 0.0, 0.0, 40, 'public')
      `);
      const rows = db
        .prepare<unknown, { id: string; share_scope: string | null }>(
          `SELECT id, share_scope FROM traces ORDER BY id`,
        )
        .all();
      // The crucial assertion: NULL stays NULL. If the legacy bulk
      // UPDATE were still in place the two `t-null-*` rows would have
      // been rewritten to 'private'. Non-NULL rows are untouched.
      expect(rows).toEqual([
        { id: "t-null-a", share_scope: null },
        { id: "t-null-b", share_scope: null },
        { id: "t-private", share_scope: "private" },
        { id: "t-public", share_scope: "public" },
      ]);
    } finally {
      db.close();
    }
  });
});
