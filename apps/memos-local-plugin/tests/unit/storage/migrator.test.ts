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
      db.exec(`
        INSERT INTO sessions (id, agent, started_at, last_seen_at)
        VALUES ('session-1', 'openclaw', 1, 1);
        INSERT INTO episodes (id, session_id, started_at)
        VALUES ('episode-1', 'session-1', 1);
      `);
      // Seed test rows: two with NULL share_scope, two with explicit values.
      db.exec(`
        INSERT INTO traces (
          id, episode_id, session_id, ts, user_text, agent_text, turn_id, share_scope
        ) VALUES
          ('t-null-a', 'episode-1', 'session-1', 10, 'user a', 'agent a', 10, NULL),
          ('t-null-b', 'episode-1', 'session-1', 20, 'user b', 'agent b', 20, NULL),
          ('t-private', 'episode-1', 'session-1', 30, 'user c', 'agent c', 30, 'private'),
          ('t-public', 'episode-1', 'session-1', 40, 'user d', 'agent d', 40, 'public')
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

  it("018-traces-ts-index creates the bare-ts index without rewriting historical migrations", () => {
    // Regression test for the Aug 2026 restart storm: `latestTraceTs()` runs
    // an unfiltered newest-first trace read several times per /api/v1/health
    // request. No existing index leads with bare `ts`, so every call was a
    // full scan + temp B-tree sort; on a large traces table that blocked the
    // synchronous better-sqlite3 event loop long enough that health probes
    // timed out and a liveness watchdog restart-looped the daemon forever.
    //
    // Published and development release trains have already used versions
    // 13-17 for unrelated migrations. The new index must therefore use 018
    // and preserve those historical bookkeeping rows verbatim.
    const { dbPath, cleanup } = tmpDb();
    cleanups.push(cleanup);
    const db = openDb({ filepath: dbPath, agent: "openclaw" });
    try {
      // Simulate a database previously migrated by the other release trains.
      db.exec(`
        CREATE TABLE schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT    NOT NULL,
          applied_at INTEGER NOT NULL
        ) STRICT;
      `);
      db.exec(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES
          (13, 'skill-repair-origin', 1),
          (14, 'episode-outcome', 2),
          (15, 'policy-merge-family', 3),
          (16, 'episode-policy-injections', 4),
          (17, 'evolution-jobs', 5)`,
      );

      const result = runMigrations(db);
      expect(result.applied).toContainEqual(expect.objectContaining({
        version: 18,
        name: "traces-ts-index",
      }));

      // The index exists...
      const index = db
        .prepare<unknown, { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_traces_ts'`,
        )
        .get();
      expect(index?.name).toBe("idx_traces_ts");

      // ...and the plan for newest-first reads uses it instead of a table
      // scan plus a temporary sort.
      const detail = db
        .prepare<unknown, { sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_traces_ts'`,
        )
        .get();
      expect(detail?.sql).toContain("ts DESC");
      const plan = db
        .prepare<unknown, { detail: string }>(
          `EXPLAIN QUERY PLAN SELECT ts FROM traces ORDER BY ts DESC, id DESC LIMIT 1`,
        )
        .all()
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain("USING COVERING INDEX idx_traces_ts");
      expect(plan).not.toContain("USE TEMP B-TREE");

      const historicalRows = db
        .prepare<unknown, { version: number; name: string; applied_at: number }>(
          `SELECT version, name, applied_at FROM schema_migrations
           WHERE version BETWEEN 13 AND 17 ORDER BY version`,
        )
        .all();
      expect(historicalRows).toEqual([
        { version: 13, name: "skill-repair-origin", applied_at: 1 },
        { version: 14, name: "episode-outcome", applied_at: 2 },
        { version: 15, name: "policy-merge-family", applied_at: 3 },
        { version: 16, name: "episode-policy-injections", applied_at: 4 },
        { version: 17, name: "evolution-jobs", applied_at: 5 },
      ]);

      // Re-running is idempotent: everything counts as skipped.
      const again = runMigrations(db);
      expect(again.applied).toHaveLength(0);
      expect(again.skipped).toBe(again.total);
    } finally {
      db.close();
    }
  });

  it("keeps skipping a version recorded under a foreign name when that migration is not repairable", () => {
    // Conservative path: only migrations in the repairable allowlist may run
    // under a version/name collision. Everything else keeps the historical
    // behaviour -- the foreign record wins and the file is skipped untouched.
    const { dbPath, cleanup } = tmpDb();
    cleanups.push(cleanup);
    const db = openDb({ filepath: dbPath, agent: "openclaw" });
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT    NOT NULL,
          applied_at INTEGER NOT NULL
        ) STRICT;
      `);
      db.exec(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (11, 'their-hub-sharing-renamed', 1)`,
      );

      const result = runMigrations(db);
      expect(result.applied.map((m) => m.version)).not.toContain(11);
      // The hub-sharing objects were NOT created because 011 was skipped...
      const hubTable = db
        .prepare<unknown, { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='hub_shared_skills'`,
        )
        .get();
      expect(hubTable).toBeUndefined();
      // ...and the foreign bookkeeping row is preserved verbatim.
      const row = db
        .prepare<unknown, { name: string }>(
          `SELECT name FROM schema_migrations WHERE version = 11`,
        )
        .get();
      expect(row?.name).toBe("their-hub-sharing-renamed");
    } finally {
      db.close();
    }
  });
});
