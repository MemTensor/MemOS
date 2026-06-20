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
        applyMigrationDdl(db, file);
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

  // Phase 2 of migration 007: ensure all namespace columns exist on every table
  // (idempotent -- ensureColumn skips if already present), then batched share_scope
  // backfill and index creation. Runs after every startup; if the bridge is killed
  // mid-backfill it resumes where it left off on the next boot.
  ensureNamespaceColumns(db);
  if (columnExists(db, "traces", "owner_agent_kind")) {
    ensureNamespaceIndexesAndBackfill(db);
  }
  ensureHubSharingSearchColumns(db);

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

// ── Migration 007 (namespace-visibility) ─────────────────────────────────────
//
// Two-phase design breaks the O(n) crash-loop:
//
//   Phase 1 — inside the migration transaction:
//     ADD COLUMN only. Metadata-only, completes in milliseconds regardless of
//     DB size. The schema_migrations record commits here.
//
//   Phase 2 — after the migration loop, outside any transaction:
//     Batched UPDATE + CREATE INDEX. Each 2,000-row UPDATE batch is its own
//     implicit transaction, so a killed bridge resumes mid-backfill rather than
//     restarting the whole migration.  The migration 007 record has already
//     committed, so Phase 1 is skipped on the next boot.

const NS_TABLES = ["sessions", "episodes", "traces", "policies", "world_model", "skills", "feedback", "decision_repairs", "l2_candidate_pool", "skill_trials", "api_logs", "audit_events"] as const;

const SHARE_TABLES = ["episodes", "traces", "policies", "world_model", "skills"] as const;

function applyMigrationDdl(db: StorageDb, file: MigrationFile): void {
  if (file.version === 3 && file.name === "embedding-retry-lease") {
    ensureEmbeddingRetryLeaseColumns(db);
    return;
  }
  if (file.version === 4 && file.name === "skill-usage") {
    ensureSkillUsageColumns(db);
    return;
  }
  if (file.version === 5 && file.name === "skill-trials") {
    if (tableExists(db, "skills") && tableExists(db, "episodes") && tableExists(db, "traces")) {
      db.exec(fs.readFileSync(file.fullPath, "utf8"));
    }
    return;
  }
  if (file.version === 6 && file.name === "world-model-version") {
    if (tableExists(db, "world_model")) {
      ensureColumn(db, "world_model", "version", "INTEGER NOT NULL DEFAULT 1");
    }
    return;
  }
  if (file.version === 7 && file.name === "namespace-visibility") {
    ensureNamespaceColumns(db);
    return;
  }
  if (file.version === 8 && file.name === "feedback-experience-metadata") {
    ensureFeedbackExperienceMetadataColumns(db);
    return;
  }
  if (file.version === 9 && file.name === "policies-fts") {
    if (tableExists(db, "policies")) {
      db.exec(fs.readFileSync(file.fullPath, "utf8"));
    }
    return;
  }
  if (file.version === 10 && file.name === "trace-policy-links") {
    if (tableExists(db, "traces") && tableExists(db, "policies")) {
      db.exec(fs.readFileSync(file.fullPath, "utf8"));
    }
    return;
  }
  if (file.version === 12 && file.name === "trace-turn-pagination-index") {
    if (tableExists(db, "traces")) {
      db.exec(fs.readFileSync(file.fullPath, "utf8"));
    }
    return;
  }
  db.exec(fs.readFileSync(file.fullPath, "utf8"));
}

function ensureEmbeddingRetryLeaseColumns(db: StorageDb): void {
  if (!tableExists(db, "embedding_retry_queue")) return;
  ensureColumn(db, "embedding_retry_queue", "claimed_by", "TEXT");
  ensureColumn(db, "embedding_retry_queue", "lease_until", "INTEGER");
}

function ensureSkillUsageColumns(db: StorageDb): void {
  if (!tableExists(db, "skills")) return;
  ensureColumn(db, "skills", "usage_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "skills", "last_used_at", "INTEGER");
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

function ensureHubSharingSearchColumns(db: StorageDb): void {
  if (!tableExists(db, "hub_shared_memories")) return;
  ensureColumn(db, "hub_shared_memories", "embedding", "BLOB");
  ensureColumn(db, "hub_shared_memories", "embedding_norm2", "REAL");
  ensureColumn(
    db,
    "hub_shared_memories",
    "visible",
    "INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1))",
  );
  ensureColumn(db, "hub_shared_memories", "deleted_at", "INTEGER");
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_hub_shared_memories_deleted
       ON hub_shared_memories(visible, deleted_at)
       WHERE visible = 0 AND deleted_at IS NOT NULL`,
  );
}

function ensureNamespaceColumns(db: StorageDb): void {
  // Owner columns on ALL namespace tables (NOT NULL with defaults --
  // matches the original v2.0.5 migration schema).
  for (const table of NS_TABLES) {
    if (!tableExists(db, table)) continue;
    ensureColumn(db, table, "owner_agent_kind", "TEXT NOT NULL DEFAULT 'unknown'");
    ensureColumn(db, table, "owner_profile_id", "TEXT NOT NULL DEFAULT 'default'");
    ensureColumn(db, table, "owner_workspace_id", "TEXT");
  }
  // share_scope only on content-bearing tables.
  for (const table of SHARE_TABLES) {
    if (!tableExists(db, table)) continue;
    ensureColumn(db, table, "share_scope", "TEXT DEFAULT 'private'");
  }
  // Uniqueness on skills.name breaks with namespace isolation — multiple agents
  // can legitimately own a skill with the same name.
  db.exec(`DROP INDEX IF EXISTS uq_skills_name`);
}

function ensureNamespaceIndexesAndBackfill(db: StorageDb): void {
  // Backfill share_scope in batches so each chunk is its own transaction.
  for (const table of SHARE_TABLES) {
    if (!tableExists(db, table) || !columnExists(db, table, "share_scope")) continue;
    const stmt = db.prepare(
      `UPDATE ${table} SET share_scope = 'private'
       WHERE share_scope IS NULL
       AND rowid IN (SELECT rowid FROM ${table} WHERE share_scope IS NULL LIMIT 2000)`,
    );
    let total = 0;
    for (;;) {
      const result = stmt.run() as { changes: number };
      if (result.changes === 0) break;
      total += result.changes;
    }
    if (total > 0) log.info("migration.backfill", { table, rows: total });
  }

  // Create owner/share indexes matching the full v2.0.5 schema.
  // IF NOT EXISTS makes each call idempotent; we log duration so a slow
  // build is visible in the agent log for future diagnosis.
  const indexes = [
    { index: "idx_sessions_owner",       table: "sessions",          ddl: `CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_agent_kind, owner_profile_id, last_seen_at DESC)` },
    { index: "idx_episodes_owner",       table: "episodes",          ddl: `CREATE INDEX IF NOT EXISTS idx_episodes_owner ON episodes(owner_agent_kind, owner_profile_id, started_at DESC)` },
    { index: "idx_episodes_share",       table: "episodes",          ddl: `CREATE INDEX IF NOT EXISTS idx_episodes_share ON episodes(share_scope, started_at DESC)` },
    { index: "idx_traces_owner",         table: "traces",            ddl: `CREATE INDEX IF NOT EXISTS idx_traces_owner ON traces(owner_agent_kind, owner_profile_id, ts DESC)` },
    { index: "idx_traces_share",         table: "traces",            ddl: `CREATE INDEX IF NOT EXISTS idx_traces_share ON traces(share_scope, ts DESC)` },
    { index: "idx_policies_owner",       table: "policies",          ddl: `CREATE INDEX IF NOT EXISTS idx_policies_owner ON policies(owner_agent_kind, owner_profile_id, updated_at DESC)` },
    { index: "idx_policies_share",       table: "policies",          ddl: `CREATE INDEX IF NOT EXISTS idx_policies_share ON policies(share_scope, updated_at DESC)` },
    { index: "idx_world_owner",          table: "world_model",       ddl: `CREATE INDEX IF NOT EXISTS idx_world_owner ON world_model(owner_agent_kind, owner_profile_id, updated_at DESC)` },
    { index: "idx_world_share",          table: "world_model",       ddl: `CREATE INDEX IF NOT EXISTS idx_world_share ON world_model(share_scope, updated_at DESC)` },
    { index: "uq_skills_owner_name",     table: "skills",            ddl: `CREATE UNIQUE INDEX IF NOT EXISTS uq_skills_owner_name ON skills(owner_agent_kind, owner_profile_id, name)` },
    { index: "idx_skills_owner",         table: "skills",            ddl: `CREATE INDEX IF NOT EXISTS idx_skills_owner ON skills(owner_agent_kind, owner_profile_id, updated_at DESC)` },
    { index: "idx_skills_share",         table: "skills",            ddl: `CREATE INDEX IF NOT EXISTS idx_skills_share ON skills(share_scope, updated_at DESC)` },
    { index: "idx_feedback_owner",       table: "feedback",          ddl: `CREATE INDEX IF NOT EXISTS idx_feedback_owner ON feedback(owner_agent_kind, owner_profile_id, ts DESC)` },
    { index: "idx_repairs_owner",        table: "decision_repairs",  ddl: `CREATE INDEX IF NOT EXISTS idx_repairs_owner ON decision_repairs(owner_agent_kind, owner_profile_id, ts DESC)` },
    { index: "idx_l2_candidate_owner",   table: "l2_candidate_pool", ddl: `CREATE INDEX IF NOT EXISTS idx_l2_candidate_owner ON l2_candidate_pool(owner_agent_kind, owner_profile_id, expires_at)` },
    { index: "idx_skill_trials_owner",   table: "skill_trials",      ddl: `CREATE INDEX IF NOT EXISTS idx_skill_trials_owner ON skill_trials(owner_agent_kind, owner_profile_id, created_at DESC)` },
    { index: "idx_api_logs_owner",       table: "api_logs",          ddl: `CREATE INDEX IF NOT EXISTS idx_api_logs_owner ON api_logs(owner_agent_kind, owner_profile_id, called_at DESC)` },
    { index: "idx_audit_owner",          table: "audit_events",      ddl: `CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_events(owner_agent_kind, owner_profile_id, ts DESC)` },
  ];
  for (const { index, table, ddl } of indexes) {
    if (!tableExists(db, table) || !columnExists(db, table, "owner_agent_kind")) continue;
    const t0 = now();
    db.exec(ddl);
    log.info("migration.index", { index, durationMs: now() - t0 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tableExists(db: StorageDb, table: string): boolean {
  return !!db
    .prepare<unknown, { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .get(table);
}

function columnExists(db: StorageDb, table: string, column: string): boolean {
  // table names here are internal constants — interpolation is safe.
  const rows = db
    .prepare<unknown, { name: string }>(`PRAGMA table_info(${table})`)
    .all();
  return rows.some((r) => r.name === column);
}

function ensureColumn(db: StorageDb, table: string, column: string, definition: string): void {
  if (!tableExists(db, table) || columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// ─────────────────────────────────────────────────────────────────────────────

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
