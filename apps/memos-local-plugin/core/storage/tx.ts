/**
 * Transaction + small SQL-building helpers.
 *
 * `openDb().tx(fn)` handles the happy path. This file adds:
 *   - `withRetry` for the rare SQLITE_BUSY we might still see on first-run.
 *   - `buildInsert` / `buildUpdate` for repos that want a dumb "column=>value"
 *     shortcut instead of hand-written SQL.
 *   - `chunkIn` for IN (?, ?, ?) queries where the argument list is dynamic.
 */

import type BetterSqlite3 from "better-sqlite3";

import { rootLogger } from "../logger/index.js";
import type { StorageDb } from "./types.js";

const log = rootLogger.child({ channel: "storage" });

/**
 * Retry a function a few times if SQLite reports SQLITE_BUSY. This should be
 * rare (better-sqlite3 is synchronous inside a process) but it can happen if
 * another process (e.g. the viewer reading a WAL snapshot) temporarily holds
 * a lock longer than `busy_timeout`.
 */
export function withRetry<T>(
  fn: () => T,
  opts: { attempts?: number; delayMs?: number; label?: string } = {},
): T {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 25;
  const label = opts.label ?? "sqlite.op";
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
        lastErr = err;
        if (i < attempts - 1) {
          log.debug("sqlite.retry", { label, attempt: i + 1, attempts, code });
          spinFor(delayMs);
          continue;
        }
      }
      throw err;
    }
  }
  throw lastErr ?? new Error(`[${label}] exhausted retries`);
}

function spinFor(ms: number): void {
  // Intentionally synchronous: the surrounding better-sqlite3 API is too.
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait; fine for < 50ms */
  }
}

// ─── Tiny SQL builders ────────────────────────────────────────────────────────

export interface InsertSpec {
  table: string;
  columns: string[];
  /** "replace" | "ignore" | "error". Default: error. */
  onConflict?: "replace" | "ignore" | "error";
}

/**
 * Build a parameterized INSERT for the given columns. Named parameters.
 * Example output:
 *   INSERT INTO traces (id, ts) VALUES (@id, @ts)
 */
export function buildInsert(spec: InsertSpec): string {
  const conflict = spec.onConflict ?? "error";
  const verb =
    conflict === "replace" ? "INSERT OR REPLACE" : conflict === "ignore" ? "INSERT OR IGNORE" : "INSERT";
  const cols = spec.columns.join(", ");
  const named = spec.columns.map((c) => `@${c}`).join(", ");
  return `${verb} INTO ${spec.table} (${cols}) VALUES (${named})`;
}

/**
 * Build a parameterized UPDATE by primary key (default `id`).
 *   UPDATE policies SET title=@title, gain=@gain WHERE id=@id
 */
export function buildUpdate(spec: { table: string; columns: string[]; pk?: string }): string {
  const pk = spec.pk ?? "id";
  const set = spec.columns
    .filter((c) => c !== pk)
    .map((c) => `${c}=@${c}`)
    .join(", ");
  return `UPDATE ${spec.table} SET ${set} WHERE ${pk}=@${pk}`;
}

/**
 * Chunk an array of ids into groups of <= `chunkSize` so IN (?, ?, ?) clauses
 * stay under SQLite's default 999-parameter cap. Use with an already-prepared
 * statement that takes a fixed-size IN list, or with `buildInClause` below.
 */
export function chunkIn<T>(items: readonly T[], chunkSize = 500): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) out.push(items.slice(i, i + chunkSize));
  return out;
}

/** Build `IN (?, ?, …)` with the right number of placeholders. */
export function buildInClause(n: number): string {
  if (n <= 0) return "IN (NULL)"; // always false
  return `IN (${new Array(n).fill("?").join(",")})`;
}

// ─── Savepoint helper (nested transactions) ──────────────────────────────────

/**
 * Execute `fn` inside a named savepoint. Useful when a repo is already inside
 * a larger transaction but wants partial rollback. Rolls back the savepoint
 * on throw; re-throws afterward.
 */
export function withSavepoint<T>(db: StorageDb, name: string, fn: () => T): T {
  const safe = sanitizeName(name);
  db.exec(`SAVEPOINT ${safe}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${safe}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO SAVEPOINT ${safe}`);
    db.exec(`RELEASE SAVEPOINT ${safe}`);
    throw err;
  }
}

function sanitizeName(s: string): string {
  // SAVEPOINT names are identifiers; keep a minimal safe alphabet.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
    throw new Error(`[storage] invalid savepoint name: ${s}`);
  }
  return s;
}

// ─── Type guards ──────────────────────────────────────────────────────────────

export function isBetterSqliteError(err: unknown): err is BetterSqlite3.SqliteError {
  return err instanceof Error && typeof (err as { code?: string }).code === "string";
}
