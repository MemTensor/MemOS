/**
 * Idempotent schema migrator.
 *
 * On open:
 *   1. Ensure the `schema_migrations` table exists.
 *   2. Enumerate `migrations/*.sql` (in lexicographic order).
 *   3. For each not-yet-applied file, run it inside a transaction.
 *   4. Insert a row into `schema_migrations` (version, name, applied_at).
 *   5. Mark the StorageDb as "ready".
 *
 * Migrations are **additive only**. Renames / drops need a major version bump.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { now } from "../time.js";
import { rootLogger } from "../logger/index.js";
import { markReady } from "./connection.js";
import type { StorageDb } from "./types.js";

const log = rootLogger.child({ channel: "storage.migration" });

const MIGRATION_FILE_PATTERN = /^(\d{3})-([a-z0-9][a-z0-9-]*)\.sql$/i;

export interface MigrationFile {
  version: number;
  name: string;
  fullPath: string;
}

export interface MigrationsResult {
  applied: Array<{ version: number; name: string; durationMs: number }>;
  skipped: number;
  total: number;
}

/**
 * Resolve the `migrations/` directory next to this file. Works both when the
 * package is run via `tsx` (source) and when it's bundled/compiled, because
 * we ship the `.sql` files as runtime assets (see `package.json#files`).
 */
export function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "migrations");
}

export function discoverMigrations(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`[storage.migration] migrations dir does not exist: ${dir}`);
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = MIGRATION_FILE_PATTERN.exec(e.name);
    if (!m) continue;
    const version = Number(m[1]);
    const name = m[2];
    files.push({ version, name, fullPath: path.join(dir, e.name) });
  }
  files.sort((a, b) => a.version - b.version);
  assertMonotonic(files);
  return files;
}

function assertMonotonic(files: MigrationFile[]): void {
  const seen = new Set<number>();
  for (const f of files) {
    if (seen.has(f.version)) {
      throw new Error(
        `[storage.migration] duplicate migration version ${f.version} (${f.fullPath})`,
      );
    }
    seen.add(f.version);
  }
}

/**
 * Run every not-yet-applied migration found under `dir`. Returns a summary.
 * Idempotent.
 */
export function runMigrations(db: StorageDb, dir: string = defaultMigrationsDir()): MigrationsResult {
  ensureSchemaMigrationsTable(db);
  const allFiles = discoverMigrations(dir);
  const appliedVersions = getAppliedVersions(db);

  const applied: MigrationsResult["applied"] = [];
  let skipped = 0;

  // better-sqlite3 ≥ v11 enables SQLITE_DBCONFIG_DEFENSIVE by default, which
  // blocks writes to `sqlite_master` even when `PRAGMA writable_schema=ON`.
  // A handful of migrations need that (e.g. 012 swaps CHECK constraints
  // in-place). Migration files are shipped with the plugin and never user
  // input, so turning unsafe mode on for the migration phase is safe.
  // `.unsafeMode()` may not be toggled inside a transaction, so we flip it
  // at the outer boundary.
  const needsUnsafe = allFiles.some(
    (f) => !appliedVersions.has(f.version) && migrationNeedsUnsafeMode(f.fullPath),
  );
  if (needsUnsafe) db.raw.unsafeMode(true);

  try {
    for (const file of allFiles) {
      if (appliedVersions.has(file.version)) {
        skipped++;
        continue;
      }
      const t0 = now();
      db.tx(() => {
        applyMigration(db, file);
        db.prepare(
          `INSERT INTO schema_migrations (version, name, applied_at) VALUES (@version, @name, @applied_at)`,
        ).run({ version: file.version, name: file.name, applied_at: now() });
      });
      const durationMs = now() - t0;
      applied.push({ version: file.version, name: file.name, durationMs });
      log.info("migration.applied", {
        version: file.version,
        name: file.name,
        durationMs,
        file: path.basename(file.fullPath),
      });
    }
  } finally {
    if (needsUnsafe) db.raw.unsafeMode(false);
  }

  markReady(db);

  log.info("migrations.summary", {
    total: allFiles.length,
    applied: applied.length,
    skipped,
  });

  return { applied, skipped, total: allFiles.length };
}

/**
 * Detect migrations that need `SQLITE_DBCONFIG_DEFENSIVE` relaxed. We
 * look for the `writable_schema` pragma (the only legitimate reason to
 * poke `sqlite_master` from SQL).
 */
function migrationNeedsUnsafeMode(fullPath: string): boolean {
  const sql = fs.readFileSync(fullPath, "utf8");
  return /PRAGMA\s+writable_schema/i.test(sql);
}

function applyMigration(db: StorageDb, file: MigrationFile): void {
  if (file.version === 3 && file.name === "embedding-retry-lease") {
    ensureEmbeddingRetryLeaseColumns(db);
    return;
  }
  db.exec(fs.readFileSync(file.fullPath, "utf8"));
}

function ensureEmbeddingRetryLeaseColumns(db: StorageDb): void {
  const columns = new Set(
    db.prepare<unknown, { name: string }>(`PRAGMA table_info(embedding_retry_queue)`)
      .all()
      .map((row) => row.name),
  );
  if (!columns.has("claimed_by")) {
    db.exec(`ALTER TABLE embedding_retry_queue ADD COLUMN claimed_by TEXT`);
  }
  if (!columns.has("lease_until")) {
    db.exec(`ALTER TABLE embedding_retry_queue ADD COLUMN lease_until INTEGER`);
  }
}

function ensureSchemaMigrationsTable(db: StorageDb): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version     INTEGER PRIMARY KEY,
       name        TEXT    NOT NULL,
       applied_at  INTEGER NOT NULL
     ) STRICT;`,
  );
}

function getAppliedVersions(db: StorageDb): Set<number> {
  const rows = db
    .prepare<unknown, { version: number }>(`SELECT version FROM schema_migrations`)
    .all();
  return new Set(rows.map((r) => r.version));
}

/**
 * Convenience helper for tests / CLIs: open, migrate, return.
 */
export function runMigrationsForPath(
  openFn: () => StorageDb,
  dir?: string,
): { db: StorageDb; result: MigrationsResult } {
  const db = openFn();
  try {
    const result = runMigrations(db, dir);
    return { db, result };
  } catch (err) {
    db.close();
    throw err;
  }
}
