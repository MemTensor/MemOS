/**
 * migration 19 is strictly schema-only: it adds gain columns and
 * the repair queue/journal tables but must never touch existing data (V,
 * priority, every policy field, kv/budget state) and must not seed the queue
 * or reset any budget.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultMigrationsDir,
  discoverMigrations,
  openDb,
  runMigrations,
  type StorageDb,
} from "../../../core/storage/index.js";

describe("storage/gain-repair-migration (19)", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-gain-19-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  /**
   * A migrations dir holding every shipped migration EXCEPT 19, so the DB
   * can be brought to a genuine pre-gain schema with real data in place.
   */
  function pre907MigrationsDir(): string {
    const src = defaultMigrationsDir();
    const dir = tmpDir();
    for (const name of fs.readdirSync(src)) {
      if (!/^(\d{3})-/.test(name)) continue;
      if (name === "019-policy-gain-value.sql") continue;
      fs.copyFileSync(path.join(src, name), path.join(dir, name));
    }
    return dir;
  }

  function columnsOf(db: StorageDb, table: string): string[] {
    return db
      .prepare<unknown, { name: string }>(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name);
  }

  function seedData(db: StorageDb): {
    traceValues: Array<{ id: string; value: number; alpha: number; r_human: number | null; priority: number }>;
    policyFields: { support: number; gain: number; status: string; title: string };
  } {
    db.exec(`
      INSERT INTO sessions(id, agent, started_at, last_seen_at) VALUES ('s907','openclaw',1,1);
      INSERT INTO episodes(id, session_id, started_at, status, trace_ids_json)
        VALUES ('ep907','s907',1,'closed','["tr907_a","tr907_b"]');
      INSERT INTO traces(id, episode_id, session_id, ts, user_text, agent_text, turn_id,
                         value, alpha, r_human, priority)
        VALUES ('tr907_a','ep907','s907',1,'u','a',0, 0.30, 0.5, 0.90, 0.3),
               ('tr907_b','ep907','s907',2,'u','a',1, -0.15, 0.5, -0.45, 0.0);
      INSERT INTO policies(id, title, trigger, procedure, verification, boundary,
                           support, gain, status, induced_by, created_at, updated_at)
        VALUES ('pol907','title','trigger','procedure','verification','boundary',
                3, 0.05, 'active', 'manual', 1, 2);
      INSERT INTO kv(key, value_json, updated_at)
        VALUES ('gain_repair_budget.ep907', '{"attempted":7,"limit":25}', 1);
    `);
    const traceValues = db
      .prepare<unknown, { id: string; value: number; alpha: number; r_human: number | null; priority: number }>(
        `SELECT id, value, alpha, r_human, priority FROM traces ORDER BY id`,
      )
      .all();
    const policy = db
      .prepare<unknown, { support: number; gain: number; status: string; title: string }>(
        `SELECT support, gain, status, title FROM policies WHERE id='pol907'`,
      )
      .get()!;
    return { traceValues, policyFields: policy };
  }

  it("reserves version 19 (no duplicates, 19 highest)", () => {
    const versions = discoverMigrations(defaultMigrationsDir()).map((f) => f.version);
    expect(versions).toContain(19);
    expect(versions.filter((v) => v === 19)).toHaveLength(1);
    expect(Math.max(...versions)).toBe(19);
  });

  it("adds gain columns/tables without touching V, priority, policy fields, kv or queue state", () => {
    const dir = pre907MigrationsDir();
    const filepath = path.join(dir, "pre907.db");
    const db = openDb({ filepath, agent: "openclaw" });
    try {
      runMigrations(db, dir);
      const before = seedData(db);
      const kvBefore = db
        .prepare<unknown, { key: string; value_json: string }>(`SELECT key, value_json FROM kv ORDER BY key`)
        .all();

      // Sanity: pre-19 schema really lacks the new columns/tables.
      expect(columnsOf(db, "traces")).not.toContain("gain_value");
      expect(columnsOf(db, "policies")).not.toContain("gain_version");

      const result = runMigrations(db);
      expect(result.applied.map((m) => m.version)).toContain(19);

      // ── New columns exist with the right defaults ────────────────────────
      const traceCols = columnsOf(db, "traces");
      expect(traceCols).toContain("gain_value");
      expect(traceCols).toContain("gain_value_source");
      expect(traceCols).toContain("gain_inference_version");
      const policyCols = columnsOf(db, "policies");
      expect(policyCols).toContain("gain_version");

      // NULL is unresolved, not neutral zero.
      const traceDefaults = db
        .prepare<unknown, { gain_value: number | null; gain_value_source: string | null; gain_inference_version: number }>(
          `SELECT gain_value, gain_value_source, gain_inference_version FROM traces WHERE id='tr907_a'`,
        )
        .get()!;
      expect(traceDefaults.gain_value).toBeNull();
      expect(traceDefaults.gain_value_source).toBeNull();
      expect(traceDefaults.gain_inference_version).toBe(0);
      const policyDefault = db
        .prepare<unknown, { gain_version: number }>(
          `SELECT gain_version FROM policies WHERE id='pol907'`,
        )
        .get()!;
      expect(policyDefault.gain_version).toBe(1);

      // ── Queue / journal tables exist, namespaced, and empty ──────────────
      const tables = db
        .prepare<unknown, { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all()
        .map((r) => r.name);
      expect(tables).toContain("gain_repair_queue");
      expect(tables).toContain("gain_repair_journal");
      expect(tables.some((t) => /budget/i.test(t))).toBe(false); // no budget table
      for (const t of ["gain_repair_queue", "gain_repair_journal"]) {
        const cols = columnsOf(db, t);
        expect(cols).toContain("owner_agent_kind");
        expect(cols).toContain("owner_profile_id");
        expect(cols).toContain("owner_workspace_id");
      }
      const queueCount = db
        .prepare<unknown, { n: number }>(`SELECT COUNT(*) AS n FROM gain_repair_queue`)
        .get()!.n;
      expect(queueCount).toBe(0); // schema only — no seeding in SQL

      // ── Existing data is byte-for-byte unchanged ─────────────────────────
      const after = db
        .prepare<unknown, { id: string; value: number; alpha: number; r_human: number | null; priority: number }>(
          `SELECT id, value, alpha, r_human, priority FROM traces ORDER BY id`,
        )
        .all();
      expect(after).toEqual(before.traceValues);
      const policy = db
        .prepare<unknown, { support: number; gain: number; status: string; title: string }>(
          `SELECT support, gain, status, title FROM policies WHERE id='pol907'`,
        )
        .get()!;
      expect(policy).toEqual(before.policyFields);
      const kvAfter = db
        .prepare<unknown, { key: string; value_json: string }>(`SELECT key, value_json FROM kv ORDER BY key`)
        .all();
      expect(kvAfter).toEqual(kvBefore); // budget state untouched, no reset
    } finally {
      db.close();
    }
  });

  it("is idempotent: a second run applies nothing and keeps data intact", () => {
    const dir = pre907MigrationsDir();
    const filepath = path.join(dir, "idem.db");
    const db = openDb({ filepath, agent: "openclaw" });
    try {
      runMigrations(db, dir);
      seedData(db);
      runMigrations(db);
      const second = runMigrations(db);
      expect(second.applied).toHaveLength(0);
      const rows = db
        .prepare<unknown, { n: number }>(`SELECT COUNT(*) AS n FROM gain_repair_queue`)
        .get()!.n;
      expect(rows).toBe(0);
    } finally {
      db.close();
    }
  });

  it("19 ships the nullable new_updated_at journal column; rows without it stay NULL and data is untouched", () => {
    const dir = pre907MigrationsDir();
    const filepath = path.join(dir, "post907.db");
    const db = openDb({ filepath, agent: "openclaw" });
    try {
      runMigrations(db, dir);
      const before = seedData(db);
      // Sanity: the pre-19 schema has no journal table at all (it is new in 19).
      const preTables = db
        .prepare<unknown, { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='gain_repair_journal'`,
        )
        .all();
      expect(preTables).toHaveLength(0);
      // Apply the real 19 (folded post-write timestamp included).
      const upgraded = runMigrations(db);
      expect(upgraded.applied.map((m) => m.version)).toContain(19);
      expect(columnsOf(db, "gain_repair_journal")).toContain("new_updated_at");
      // A journal row that never records the post-write timestamp…
      db.exec(`
        INSERT INTO gain_repair_journal(id, batch_id, owner_agent_kind, owner_profile_id,
          policy_id, old_gain, new_gain, old_gain_version, new_gain_version,
          old_status, new_status, old_support, new_support, result, created_at)
        VALUES ('jj907','gr_907','openclaw','default','pol907',
          0.05, 0.5, 1, 2, 'candidate', 'active', 3, 3, 'completed', 2);
      `);
      // …stays NULL (NOT rollback-eligible: the post-write timestamp was
      // never recorded), while a recorded timestamp round-trips.
      const row = db
        .prepare<unknown, { new_updated_at: number | null; new_gain: number }>(
          `SELECT new_updated_at, new_gain FROM gain_repair_journal WHERE id='jj907'`,
        )
        .get()!;
      expect(row.new_updated_at).toBeNull();
      expect(row.new_gain).toBe(0.5);
      db.exec(`UPDATE gain_repair_journal SET new_updated_at = 99 WHERE id='jj907'`);
      const stamped = db
        .prepare<unknown, { new_updated_at: number | null }>(
          `SELECT new_updated_at FROM gain_repair_journal WHERE id='jj907'`,
        )
        .get()!;
      expect(stamped.new_updated_at).toBe(99);
      const policy = db
        .prepare<unknown, { support: number; gain: number; status: string; title: string }>(
          `SELECT support, gain, status, title FROM policies WHERE id='pol907'`,
        )
        .get()!;
      expect(policy).toEqual(before.policyFields);
    } finally {
      db.close();
    }
  });
});
