/**
 * Tiny key/value store. Values are JSON-serialized; keys are arbitrary strings.
 *
 * Use this for housekeeping that doesn't deserve its own table:
 *   - last_trace_ts, installed_version
 *   - hub.last_sync_at, telemetry.last_batch_id
 *   - debug toggles
 */

import { now } from "../../time.js";
import type { StorageDb } from "../types.js";
import { fromJsonText, toJsonText } from "./_helpers.js";

export function makeKvRepo(db: StorageDb) {
  const upsert = db.prepare<{ key: string; value: string; updated: number }>(
    `INSERT INTO kv (key, value_json, updated_at) VALUES (@key, @value, @updated)
     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
  );
  const select = db.prepare<{ key: string }, { value_json: string; updated_at: number }>(
    `SELECT value_json, updated_at FROM kv WHERE key=@key`,
  );
  const del = db.prepare<{ key: string }>(`DELETE FROM kv WHERE key=@key`);
  const list = db.prepare<unknown, { key: string; value_json: string; updated_at: number }>(
    `SELECT key, value_json, updated_at FROM kv ORDER BY key`,
  );
  const incrementNumber = db.prepare<{ key: string; updated: number }>(
    `INSERT INTO kv (key, value_json, updated_at) VALUES (@key, '1', @updated)
     ON CONFLICT(key) DO UPDATE SET
       value_json=CAST(MAX(0, CAST(kv.value_json AS INTEGER)) + 1 AS TEXT),
       updated_at=excluded.updated_at`,
  );

  return {
    set<T>(key: string, value: T): void {
      upsert.run({ key, value: toJsonText(value), updated: now() });
    },

    get<T = unknown>(key: string, fallback: T): T {
      const row = select.get({ key });
      if (!row) return fallback;
      return fromJsonText<T>(row.value_json, fallback);
    },

    getWithMeta<T = unknown>(
      key: string,
      fallback: T,
    ): { value: T; updatedAt: number | null } {
      const row = select.get({ key });
      if (!row) return { value: fallback, updatedAt: null };
      return {
        value: fromJsonText<T>(row.value_json, fallback),
        updatedAt: row.updated_at,
      };
    },

    /** Atomically increment a non-negative integer housekeeping value. */
    incrementNumber(key: string): number {
      incrementNumber.run({ key, updated: now() });
      const row = select.get({ key });
      return row ? fromJsonText<number>(row.value_json, 0) : 0;
    },

    del(key: string): void {
      del.run({ key });
    },

    all(): Array<{ key: string; value: unknown; updatedAt: number }> {
      return list.all().map((r) => ({
        key: r.key,
        value: fromJsonText<unknown>(r.value_json, null),
        updatedAt: r.updated_at,
      }));
    },
  };
}
