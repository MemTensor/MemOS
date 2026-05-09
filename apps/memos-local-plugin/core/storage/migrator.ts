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
  const compiled = path.join(here, "migrations");
  if (fs.existsSync(compiled)) return compiled;

  // Local package installs keep source files for debugging; this fallback
  // makes compiled code resilient if runtime assets were not copied.
  const source = path.resolve(here, "..", "..", "..", "core", "storage", "migrations");
  return fs.existsSync(source) ? source : compiled;
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
  if (file.version === 4 && file.name === "skill-usage") {
    ensureSkillUsageColumns(db);
    return;
  }
  if (file.version === 6 && file.name === "world-model-version") {
    if (tableExists(db, "world_model")) {
      ensureColumn(db, "world_model", "version", "INTEGER NOT NULL DEFAULT 1");
    }
    return;
  }
  if (file.version === 7 && file.name === "namespace-visibility") {
    ensureNamespaceVisibilityColumns(db);
    return;
  }
  if (file.version === 8 && file.name === "feedback-experience-metadata") {
    ensureFeedbackExperienceMetadataColumns(db);
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

function ensureSkillUsageColumns(db: StorageDb): void {
  const table = db
    .prepare<unknown, { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='skills'`,
    )
    .get();
  if (!table) return;
  const columns = new Set(
    db.prepare<unknown, { name: string }>(`PRAGMA table_info(skills)`)
      .all()
      .map((row) => row.name),
  );
  if (!columns.has("usage_count")) {
    db.exec(`ALTER TABLE skills ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.has("last_used_at")) {
    db.exec(`ALTER TABLE skills ADD COLUMN last_used_at INTEGER`);
  }
}

function ensureNamespaceVisibilityColumns(db: StorageDb): void {
  const ownerTables = [
    "sessions",
    "episodes",
    "traces",
    "policies",
    "world_model",
    "skills",
    "feedback",
    "decision_repairs",
    "l2_candidate_pool",
    "skill_trials",
    "api_logs",
    "audit_events",
  ];
  for (const table of ownerTables) {
    if (!tableExists(db, table)) continue;
    ensureColumn(db, table, "owner_agent_kind", "TEXT NOT NULL DEFAULT 'unknown'");
    ensureColumn(db, table, "owner_profile_id", "TEXT NOT NULL DEFAULT 'default'");
    ensureColumn(db, table, "owner_workspace_id", "TEXT");
  }
  for (const table of ["episodes", "traces", "policies", "world_model", "skills"]) {
    if (!tableExists(db, table)) continue;
    ensureColumn(db, table, "share_scope", "TEXT DEFAULT 'private'");
    db.exec(`UPDATE ${table} SET share_scope='private' WHERE share_scope IS NULL`);
  }

  execIfTable(db, "skills", `DROP INDEX IF EXISTS uq_skills_name`);
  execIfTable(db, "sessions", `CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_agent_kind, owner_profile_id, last_seen_at DESC)`);
  execIfTable(db, "episodes", `CREATE INDEX IF NOT EXISTS idx_episodes_owner ON episodes(owner_agent_kind, owner_profile_id, started_at DESC)`);
  execIfTable(db, "episodes", `CREATE INDEX IF NOT EXISTS idx_episodes_share ON episodes(share_scope, started_at DESC)`);
  execIfTable(db, "traces", `CREATE INDEX IF NOT EXISTS idx_traces_owner ON traces(owner_agent_kind, owner_profile_id, ts DESC)`);
  execIfTable(db, "traces", `CREATE INDEX IF NOT EXISTS idx_traces_share ON traces(share_scope, ts DESC)`);
  execIfTable(db, "policies", `CREATE INDEX IF NOT EXISTS idx_policies_owner ON policies(owner_agent_kind, owner_profile_id, updated_at DESC)`);
  execIfTable(db, "policies", `CREATE INDEX IF NOT EXISTS idx_policies_share ON policies(share_scope, updated_at DESC)`);
  execIfTable(db, "world_model", `CREATE INDEX IF NOT EXISTS idx_world_owner ON world_model(owner_agent_kind, owner_profile_id, updated_at DESC)`);
  execIfTable(db, "world_model", `CREATE INDEX IF NOT EXISTS idx_world_share ON world_model(share_scope, updated_at DESC)`);
  execIfTable(db, "skills", `CREATE UNIQUE INDEX IF NOT EXISTS uq_skills_owner_name ON skills(owner_agent_kind, owner_profile_id, name)`);
  execIfTable(db, "skills", `CREATE INDEX IF NOT EXISTS idx_skills_owner ON skills(owner_agent_kind, owner_profile_id, updated_at DESC)`);
  execIfTable(db, "skills", `CREATE INDEX IF NOT EXISTS idx_skills_share ON skills(share_scope, updated_at DESC)`);
  execIfTable(db, "feedback", `CREATE INDEX IF NOT EXISTS idx_feedback_owner ON feedback(owner_agent_kind, owner_profile_id, ts DESC)`);
  execIfTable(db, "decision_repairs", `CREATE INDEX IF NOT EXISTS idx_repairs_owner ON decision_repairs(owner_agent_kind, owner_profile_id, ts DESC)`);
  execIfTable(db, "l2_candidate_pool", `CREATE INDEX IF NOT EXISTS idx_l2_candidate_owner ON l2_candidate_pool(owner_agent_kind, owner_profile_id, expires_at)`);
  execIfTable(db, "skill_trials", `CREATE INDEX IF NOT EXISTS idx_skill_trials_owner ON skill_trials(owner_agent_kind, owner_profile_id, created_at DESC)`);
  execIfTable(db, "api_logs", `CREATE INDEX IF NOT EXISTS idx_api_logs_owner ON api_logs(owner_agent_kind, owner_profile_id, called_at DESC)`);
  execIfTable(db, "audit_events", `CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_events(owner_agent_kind, owner_profile_id, ts DESC)`);
}

function ensureFeedbackExperienceMetadataColumns(db: StorageDb): void {
  if (!tableExists(db, "policies")) return;
  ensureColumn(
    db,
    "policies",
    "experience_type",
    `TEXT NOT NULL DEFAULT 'success_pattern'
      CHECK (experience_type IN ('success_pattern','repair_validated','failure_avoidance','repair_instruction','preference','verifier_feedback','procedural'))`,
  );
  ensureColumn(
    db,
    "policies",
    "evidence_polarity",
    `TEXT NOT NULL DEFAULT 'positive'
      CHECK (evidence_polarity IN ('positive','negative','neutral','mixed'))`,
  );
  ensureColumn(db, "policies", "salience", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "policies", "confidence", "REAL NOT NULL DEFAULT 0.5");
  ensureColumn(
    db,
    "policies",
    "source_feedback_ids_json",
    "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_feedback_ids_json))",
  );
  ensureColumn(
    db,
    "policies",
    "source_trace_ids_json",
    "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_trace_ids_json))",
  );
  ensureColumn(
    db,
    "policies",
    "verifier_meta_json",
    "TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(verifier_meta_json))",
  );
  ensureColumn(
    db,
    "policies",
    "skill_eligible",
    "INTEGER NOT NULL DEFAULT 1 CHECK (skill_eligible IN (0,1))",
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_experience ON policies(experience_type, evidence_polarity, updated_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_skill_eligible ON policies(skill_eligible, status, updated_at DESC)`);
}

function execIfTable(db: StorageDb, table: string, sql: string): void {
  if (tableExists(db, table)) db.exec(sql);
}

function tableExists(db: StorageDb, table: string): boolean {
  return Boolean(
    db.prepare<{ name: string }, { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=@name`,
    ).get({ name: table }),
  );
}

function ensureColumn(db: StorageDb, table: string, column: string, definition: string): void {
  const columns = new Set(
    db.prepare<unknown, { name: string }>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
  if (!columns.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
