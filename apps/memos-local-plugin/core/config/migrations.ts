import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { MemosError } from "../../agent-contract/errors.js";
import type { ResolvedHome } from "./paths.js";
import { parseDoc } from "./yaml.js";

const MIGRATION_ID = "hermes-viewer-port-v1";
const OLD_HERMES_PORT = 18799;
const HERMES_PORT = 18800;

export async function migrateHermesViewerPort(home: ResolvedHome): Promise<void> {
  const migrationsDir = join(home.root, ".migrations");
  const markerFile = join(migrationsDir, `${MIGRATION_ID}.json`);
  if (await pathExists(markerFile)) return;
  if (!await pathExists(home.configFile)) return;

  await fs.mkdir(migrationsDir, { recursive: true });
  const lockDir = join(migrationsDir, `${MIGRATION_ID}.lock`);
  const acquired = await acquireMigrationLock(lockDir, markerFile);
  if (!acquired) return;

  try {
    if (await pathExists(markerFile)) return;
    const original = await fs.readFile(home.configFile, "utf8");
    const doc = parseDoc(original, home.configFile);
    const port = doc.getIn(["viewer", "port"]);
    if (port !== OLD_HERMES_PORT) {
      await atomicWrite(markerFile, `${JSON.stringify({
        version: 1,
        migration: MIGRATION_ID,
        result: "not-needed",
      }, null, 2)}\n`);
      return;
    }

    const backupName = `${MIGRATION_ID}.config.yaml.bak`;
    const backupFile = join(migrationsDir, backupName);
    await fs.writeFile(backupFile, original, { encoding: "utf8", mode: 0o600, flag: "wx" })
      .catch(async (err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
        const existing = await fs.readFile(backupFile, "utf8");
        if (existing !== original) {
          throw new MemosError(
            "config_write_failed",
            `migration backup already exists with different content: ${backupFile}`,
          );
        }
      });

    doc.setIn(["viewer", "port"], HERMES_PORT);
    await atomicWrite(home.configFile, doc.toString({ lineWidth: 0 }));
    await atomicWrite(markerFile, `${JSON.stringify({
      version: 1,
      migration: MIGRATION_ID,
      from: OLD_HERMES_PORT,
      to: HERMES_PORT,
      backup: backupName,
    }, null, 2)}\n`);
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

async function acquireMigrationLock(lockDir: string, markerFile: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await pathExists(markerFile)) return false;
    try {
      await fs.mkdir(lockDir);
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw e;
      try {
        const stat = await fs.stat(lockDir);
        if (Date.now() - stat.mtimeMs > 60_000) {
          await fs.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new MemosError("config_write_failed", `timed out waiting for migration lock: ${lockDir}`);
}

async function atomicWrite(target: string, text: string): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true });
  const tempFile = join(dirname(target), `.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempFile, text, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(tempFile, target);
  } catch (err) {
    await fs.unlink(tempFile).catch(() => undefined);
    throw err;
  }
  await fs.chmod(target, 0o600).catch(() => undefined);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
