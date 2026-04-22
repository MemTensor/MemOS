/**
 * Open and own a `better-sqlite3` database handle.
 *
 * Responsibilities of this module:
 *   1. Open the file with the right pragmas (WAL, foreign keys, busy timeout).
 *   2. Register custom functions we need across the codebase (none yet, but
 *      `cosine_sim` will land in `vector.ts`).
 *   3. Provide a stable `StorageDb` facade that hides `BetterSqlite3` from the
 *      rest of `core/`.
 *
 * This module **does not** run migrations — that's `migrator.ts`. Callers are
 * expected to open the DB, run migrations, *then* hand the DB to repos.
 */

import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { rootLogger } from "../logger/index.js";
import type { OpenDbOptions, StorageDb, StorageStmt } from "./types.js";

const log = rootLogger.child({ channel: "storage" });

export function openDb(opts: OpenDbOptions): StorageDb {
  const { filepath, agent } = opts;
  const readonly = opts.readonly ?? false;
  const wal = opts.wal ?? true;
  const busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
  const synchronous = opts.synchronous ?? "NORMAL";

  // Make sure the directory exists. better-sqlite3 errors out if it doesn't.
  if (!readonly) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
  }

  const raw = new BetterSqlite3(filepath, {
    readonly,
    fileMustExist: readonly ? true : false,
  });

  // Log open with operational metadata; nothing sensitive.
  log.info("sqlite.open", { filepath, agent, readonly, wal, busyTimeoutMs });

  if (!readonly) {
    raw.pragma(`journal_mode = ${wal ? "WAL" : "DELETE"}`);
    raw.pragma(`synchronous = ${synchronous}`);
    raw.pragma("foreign_keys = ON");
    raw.pragma("temp_store = MEMORY");
    raw.pragma(`busy_timeout = ${busyTimeoutMs}`);
    // Better concurrency: stop readers from blocking writers briefly.
    raw.pragma("wal_autocheckpoint = 1000");
  } else {
    raw.pragma(`busy_timeout = ${busyTimeoutMs}`);
    raw.pragma("foreign_keys = ON");
  }

  // We deliberately type the cache as `any` — the upstream Statement type is
  // very particular about `BindParameters extends unknown[]`, which doesn't
  // mix well with our agnostic StorageStmt facade. We re-type on the way out.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmtCache = new Map<string, any>();
  let ready = false;
  let closed = false;

  function ensureOpen(): void {
    if (closed) {
      throw new Error(`[storage] operation on closed database ${filepath}`);
    }
  }

  const db: StorageDb = {
    raw,
    filepath,
    agent,

    isReady(): boolean {
      return ready;
    },

    close(): void {
      if (closed) return;
      closed = true;
      stmtCache.clear();
      try {
        raw.close();
      } catch (err) {
        log.warn("sqlite.close.error", { filepath, err: serializeError(err) });
        return;
      }
      log.info("sqlite.close", { filepath, agent });
    },

    tx<T>(fn: (d: StorageDb) => T): T {
      ensureOpen();
      // better-sqlite3's `.transaction()` handles BEGIN/COMMIT/ROLLBACK for us.
      // We hand the same `db` back so repos compose naturally.
      const wrapped = raw.transaction(() => fn(db));
      return wrapped();
    },

    exec(sql: string): void {
      ensureOpen();
      raw.exec(sql);
    },

    prepare<TArgs = unknown, TRow = unknown>(sql: string): StorageStmt<TArgs, TRow> {
      ensureOpen();
      let stmt = stmtCache.get(sql);
      if (!stmt) {
        stmt = raw.prepare(sql);
        stmtCache.set(sql, stmt);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s: any = stmt;
      return {
        run: (args?: TArgs) =>
          (args === undefined ? s.run() : s.run(args as unknown)) as BetterSqlite3.RunResult,
        get: (args?: TArgs) =>
          (args === undefined ? s.get() : s.get(args as unknown)) as TRow | undefined,
        all: (args?: TArgs) =>
          (args === undefined ? s.all() : s.all(args as unknown)) as TRow[],
        iterate: (args?: TArgs) =>
          (args === undefined
            ? s.iterate()
            : s.iterate(args as unknown)) as IterableIterator<TRow>,
      };
    },
  };

  // `markReady` is internal — only `migrator.ts` calls it after migrations
  // succeed. We expose it via a symbol-keyed back-door so it's not part of the
  // public surface but still callable within the storage module.
  (db as unknown as { [MARK_READY]: () => void })[MARK_READY] = () => {
    ready = true;
  };

  return db;
}

export const MARK_READY = Symbol.for("memos.storage.markReady");

export function markReady(db: StorageDb): void {
  const fn = (db as unknown as { [MARK_READY]: (() => void) | undefined })[MARK_READY];
  if (typeof fn === "function") fn();
}

function serializeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Unknown", message: String(err) };
}
