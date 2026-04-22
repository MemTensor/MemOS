/**
 * Storage-layer types.
 *
 * The rest of `core/` should depend on *these* types, not on better-sqlite3
 * directly. That gives us room to swap the engine later (e.g. libsql, turso)
 * without rewriting every repo.
 */

import type BetterSqlite3 from "better-sqlite3";

import type { EpochMs, EpisodeId, TraceId } from "../types.js";

// ─── Database handle ─────────────────────────────────────────────────────────

/**
 * Thin wrapper so every repo sees the same shape. We expose `raw` for the
 * rare places that genuinely need a better-sqlite3 feature (e.g. `pragma`),
 * but everything routine goes through the helper methods.
 */
export interface StorageDb {
  readonly raw: BetterSqlite3.Database;
  readonly filepath: string;
  /** User-home-resolved. Useful for debug logs / status endpoints. */
  readonly agent: string;

  /** True iff this database has run `runMigrations` at least once. */
  isReady(): boolean;

  /** Close the underlying connection. Idempotent. */
  close(): void;

  /** Wrap a function in an immediate transaction. Rolls back on throw. */
  tx<T>(fn: (db: StorageDb) => T): T;

  /** Run a pragma or arbitrary DDL. */
  exec(sql: string): void;

  /** Prepare + cache a statement by (readonly) text. */
  prepare<TArgs = unknown, TRow = unknown>(sql: string): StorageStmt<TArgs, TRow>;
}

export interface StorageStmt<TArgs = unknown, TRow = unknown> {
  run(args?: TArgs): BetterSqlite3.RunResult;
  get(args?: TArgs): TRow | undefined;
  all(args?: TArgs): TRow[];
  /** Iterate lazily; useful for large result sets. */
  iterate(args?: TArgs): IterableIterator<TRow>;
}

// ─── Open options ────────────────────────────────────────────────────────────

export interface OpenDbOptions {
  /** Absolute path to the sqlite file. */
  filepath: string;
  /** Logging context — usually "openclaw" or "hermes". */
  agent: string;
  /** Open read-only (for viewer snapshots / CLI). Default: false. */
  readonly?: boolean;
  /** Override WAL; default `true`. */
  wal?: boolean;
  /**
   * Busy timeout (ms). Hiatus between concurrent writers in the same process
   * is small thanks to WAL, but set non-zero to survive the daemon + viewer
   * hitting the file at the same time. Default: 5000.
   */
  busyTimeoutMs?: number;
  /**
   * Run `PRAGMA synchronous = NORMAL` (default) or `FULL`. NORMAL is a good
   * trade-off with WAL; FULL is only for paranoid users.
   */
  synchronous?: "NORMAL" | "FULL";
}

// ─── Repository query helpers ─────────────────────────────────────────────────

export interface PageOptions {
  limit?: number;       // default 50
  offset?: number;      // default 0
  /** If true, orders DESC by the repo's canonical time column. Default true. */
  newestFirst?: boolean;
}

export interface TimeRange {
  fromMs?: EpochMs;
  toMs?: EpochMs;
}

export interface TraceListFilter extends PageOptions, TimeRange {
  sessionId?: string;
  episodeId?: EpisodeId;
  /** Only traces with |value| >= this (absolute). */
  minAbsValue?: number;
  traceIds?: TraceId[];
}

export interface PolicyListFilter extends PageOptions, TimeRange {
  status?: "candidate" | "active" | "archived";
  /** Minimum support count. */
  minSupport?: number;
}

export interface SkillListFilter extends PageOptions {
  status?: "candidate" | "active" | "archived";
  minEta?: number;
}

export interface EpisodeListFilter extends PageOptions, TimeRange {
  sessionId?: string;
  status?: "open" | "closed";
}

export interface FeedbackListFilter extends PageOptions, TimeRange {
  episodeId?: EpisodeId;
  traceId?: TraceId;
  polarity?: "positive" | "negative" | "neutral";
}

// ─── Internal: column de-serialization helpers ────────────────────────────────

/** Raw row shape as produced by `better-sqlite3` (before JSON/Float32 re-inflate). */
export type RawRow = Record<string, unknown>;
