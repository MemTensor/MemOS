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
});
