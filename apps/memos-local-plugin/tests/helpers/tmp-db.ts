/**
 * Spin up a throwaway SQLite database in a temp directory, apply migrations,
 * and hand back `{ db, repos, cleanup }`. Meant for storage-layer unit tests.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  makeRepos,
  openDb,
  runMigrations,
  type Repos,
  type StorageDb,
} from "../../core/storage/index.js";

export interface TmpDbHandle {
  db: StorageDb;
  repos: Repos;
  dir: string;
  filepath: string;
  cleanup: () => void;
}

export function makeTmpDb(opts: { agent?: string } = {}): TmpDbHandle {
  const agent = opts.agent ?? "openclaw";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-storage-"));
  const filepath = path.join(dir, "memos.db");
  const db = openDb({ filepath, agent });
  runMigrations(db);
  const repos = makeRepos(db);

  function cleanup(): void {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  return { db, repos, dir, filepath, cleanup };
}
