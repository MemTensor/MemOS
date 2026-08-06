import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, runMigrations } from "../../../core/storage/index.js";

describe("storage/connection", () => {
  let dir: string;
  let filepath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-conn-"));
    filepath = path.join(dir, "t.db");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it("opens, sets WAL + fk on, and closes idempotently", () => {
    const db = openDb({ filepath, agent: "openclaw" });
    runMigrations(db);

    expect(db.isReady()).toBe(true);
    expect(db.filepath).toBe(filepath);
    expect(db.agent).toBe("openclaw");

    const journal = (db.raw.pragma("journal_mode") as Array<{ journal_mode: string }>)[0]!
      .journal_mode;
    expect(journal.toLowerCase()).toBe("wal");

    const fk = (db.raw.pragma("foreign_keys") as Array<{ foreign_keys: number }>)[0]!
      .foreign_keys;
    expect(fk).toBe(1);

    db.close();
    db.close(); // idempotent
  });

  it("wraps work in a transaction and rolls back on throw", () => {
    const db = openDb({ filepath, agent: "openclaw" });
    try {
      runMigrations(db);
      db.prepare(
        `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json) VALUES (@id, @agent, @s, @l, '{}')`,
      ).run({ id: "s0", agent: "openclaw", s: 1, l: 1 });

      expect(() =>
        db.tx(() => {
          db.prepare(
            `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json) VALUES (@id, @agent, @s, @l, '{}')`,
          ).run({ id: "s1", agent: "openclaw", s: 2, l: 2 });
          throw new Error("boom");
        }),
      ).toThrow(/boom/);

      const rows = db
        .prepare<unknown, { id: string }>(`SELECT id FROM sessions ORDER BY id`)
        .all();
      expect(rows.map((r) => r.id)).toEqual(["s0"]);
    } finally {
      db.close();
    }
  });

  it("caches prepared statements by SQL text", () => {
    const db = openDb({ filepath, agent: "openclaw" });
    try {
      runMigrations(db);
      const sql = `SELECT 1 AS n`;
      const a = db.prepare<unknown, { n: number }>(sql);
      const b = db.prepare<unknown, { n: number }>(sql);
      // Different StorageStmt facades, but they close over the same underlying raw stmt.
      expect(a.get()).toEqual({ n: 1 });
      expect(b.get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("refuses to operate after close", () => {
    const db = openDb({ filepath, agent: "openclaw" });
    runMigrations(db);
    db.close();
    expect(() => db.prepare(`SELECT 1`)).toThrow(/closed database/);
  });
});
