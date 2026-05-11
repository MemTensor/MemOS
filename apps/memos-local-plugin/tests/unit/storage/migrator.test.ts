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
});
