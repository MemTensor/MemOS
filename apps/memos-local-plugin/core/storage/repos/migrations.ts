import type { StorageDb } from "../types.js";

export interface AppliedMigrationRow {
  version: number;
  name: string;
  appliedAt: number;
}

export function makeMigrationsRepo(db: StorageDb) {
  const list = db.prepare<unknown, { version: number; name: string; applied_at: number }>(
    `SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC`,
  );

  return {
    listApplied(): AppliedMigrationRow[] {
      return list.all().map((r) => ({
        version: r.version,
        name: r.name,
        appliedAt: r.applied_at,
      }));
    },

    highestAppliedVersion(): number | null {
      const rows = this.listApplied();
      return rows.length === 0 ? null : rows[rows.length - 1]!.version;
    },
  };
}
