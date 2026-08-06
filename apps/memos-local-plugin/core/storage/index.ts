/**
 * Public entry point for `core/storage/`.
 *
 * Typical usage:
 *   ```ts
 *   const db = openDb({ filepath, agent });
 *   runMigrations(db);                      // idempotent
 *   const repos = makeRepos(db);
 *   // ... use `repos.traces`, `repos.policies`, etc.
 *   db.close();
 *   ```
 */

export { openDb, markReady } from "./connection.js";
export {
  runMigrations,
  runMigrationsForPath,
  defaultMigrationsDir,
  discoverMigrations,
  type MigrationFile,
  type MigrationsResult,
} from "./migrator.js";
export {
  withRetry,
  withSavepoint,
  buildInsert,
  buildUpdate,
  chunkIn,
  buildInClause,
  isBetterSqliteError,
} from "./tx.js";
export {
  encodeVector,
  decodeVector,
  cosine,
  cosinePrenormed,
  dot,
  norm2,
  topKCosine,
  scanAndTopK,
  type VectorHit,
  type VectorRow,
  type VectorScanOptions,
  type ScanRow,
} from "./vector.js";
export { makeRepos, type Repos } from "./repos/index.js";
export type {
  OpenDbOptions,
  StorageDb,
  StorageStmt,
  PageOptions,
  TimeRange,
  TraceListFilter,
  PolicyListFilter,
  SkillListFilter,
  EpisodeListFilter,
  FeedbackListFilter,
} from "./types.js";
