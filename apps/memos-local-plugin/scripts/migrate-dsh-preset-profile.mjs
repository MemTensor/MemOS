#!/usr/bin/env node
/** Explicit data repair only; never run automatically when the plugin starts. */
import Database from "better-sqlite3";
import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const AGENT = "deepseek-harness";
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * Move only the selected DSH profile. IDs, vectors, sharing and references stay
 * intact. Stop every writer to this database before applying the repair.
 * @param {{dbPath:string, from:string, to:string, apply?:boolean, backupPath?:string}} options
 */
export async function migrateDshPresetProfile(options) {
  const { from, to } = options;
  if (
    ![from, to].every(
      (id) => typeof id === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(id),
    ) ||
    from === to
  ) {
    throw new Error(
      "Specify two distinct canonical profile IDs using lowercase letters, digits, hyphens or underscores.",
    );
  }
  const dbPath = resolve(options.dbPath);
  const apply = options.apply === true;
  if (
    apply &&
    (!options.backupPath || resolve(options.backupPath) === dbPath)
  ) {
    throw new Error(
      "Applying migration requires --backup with a new path distinct from the database.",
    );
  }
  const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .filter(({ name }) => {
        const columns = new Set(
          db
            .prepare(`PRAGMA table_info(${quote(name)})`)
            .all()
            .map((column) => column.name),
        );
        return (
          columns.has("owner_agent_kind") && columns.has("owner_profile_id")
        );
      });
    const counts = Object.fromEntries(
      tables.map(({ name }) => [
        name,
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM ${quote(name)} WHERE owner_agent_kind=? AND owner_profile_id=?`,
          )
          .get(AGENT, from).n,
      ]),
    );
    if (!apply) return { from, to, dryRun: true, counts };

    const backupPath = resolve(options.backupPath);
    // Reserve without clobbering an existing backup. SQLite's backup API includes
    // committed WAL data, unlike copying only the main .db file.
    closeSync(openSync(backupPath, "wx", 0o600));
    await db.backup(backupPath);
    db.transaction(() => {
      for (const { name } of tables) {
        if (name === "sessions" || name === "episodes") {
          const rows = db
            .prepare(
              `SELECT id,meta_json FROM ${quote(name)} WHERE owner_agent_kind=? AND owner_profile_id=?`,
            )
            .all(AGENT, from);
          const updateMeta = db.prepare(
            `UPDATE ${quote(name)} SET meta_json=? WHERE id=?`,
          );
          for (const row of rows) {
            const meta = JSON.parse(row.meta_json);
            if (meta && typeof meta === "object" && !Array.isArray(meta)) {
              if (
                meta.namespace?.agentKind === AGENT &&
                meta.namespace.profileId === from
              ) {
                meta.namespace.profileId = to;
                if (meta.namespace.profileLabel === from)
                  meta.namespace.profileLabel = to;
              }
              if (meta.ownerProfileId === from) meta.ownerProfileId = to;
              updateMeta.run(JSON.stringify(meta), row.id);
            }
          }
        }
        // Uniqueness conflicts (e.g. skill names) abort the entire transaction;
        // never overwrite the target profile's data to make a merge succeed.
        db.prepare(
          `UPDATE ${quote(name)} SET owner_profile_id=? WHERE owner_agent_kind=? AND owner_profile_id=?`,
        ).run(to, AGENT, from);
      }
    })();
    return { from, to, dryRun: false, counts, backupPath };
  } finally {
    db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        db: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        backup: { type: "string" },
        apply: { type: "boolean", default: false },
      },
    });
    if (!values.db || !values.from || !values.to)
      throw new Error(
        "Usage: node scripts/migrate-dsh-preset-profile.mjs --db <memos.db> --from <legacy-preset> --to <configured-profile> [--apply --backup <new-backup.db>]",
      );
    console.log(
      JSON.stringify(
        await migrateDshPresetProfile({
          dbPath: values.db,
          from: values.from,
          to: values.to,
          apply: values.apply,
          backupPath: values.backup,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
