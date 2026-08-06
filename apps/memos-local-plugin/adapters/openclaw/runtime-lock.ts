import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ResolvedHome } from "../../core/config/index.js";

const LOCK_DIRNAME = "openclaw-runtime.lock";
const OWNER_FILENAME = "owner.json";
const UNWRITTEN_OWNER_STALE_MS = 30_000;

export interface OpenClawRuntimeLockOwner {
  pluginId: string;
  version: string;
  pid: number;
  token: string;
  startedAt: number;
  dbFile: string;
  viewerPort: number;
}

export interface OpenClawRuntimeLockHandle {
  lockDir: string;
  owner: OpenClawRuntimeLockOwner;
  release(): void;
}

export interface AcquireOpenClawRuntimeLockOptions {
  home: ResolvedHome;
  pluginId: string;
  version: string;
  viewerPort: number;
  pid?: number;
  now?: () => number;
  unwrittenOwnerStaleMs?: number;
  /**
   * Skip lock acquisition for read-only diagnostic processes (e.g., `openclaw doctor`).
   * When true, returns a no-op lock handle that doesn't create lock files.
   */
  skipLock?: boolean;
}

export class DuplicateOpenClawRuntimeError extends Error {
  readonly code = "duplicate_instance";
  readonly lockDir: string;
  readonly owner: OpenClawRuntimeLockOwner | null;

  constructor(lockDir: string, owner: OpenClawRuntimeLockOwner | null) {
    const detail = owner
      ? `pid=${owner.pid} startedAt=${new Date(owner.startedAt).toISOString()}`
      : "owner=unknown";
    super(`memos-local OpenClaw runtime is already active (${detail})`);
    this.name = "DuplicateOpenClawRuntimeError";
    this.lockDir = lockDir;
    this.owner = owner;
  }
}

export function openClawRuntimeLockDir(home: ResolvedHome): string {
  return path.join(home.daemonDir, LOCK_DIRNAME);
}

export function acquireOpenClawRuntimeLock(
  options: AcquireOpenClawRuntimeLockOptions,
): OpenClawRuntimeLockHandle {
  const lockDir = openClawRuntimeLockDir(options.home);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;

  // Skip lock acquisition for diagnostic processes (e.g., openclaw doctor)
  if (options.skipLock) {
    const noopOwner: OpenClawRuntimeLockOwner = {
      pluginId: options.pluginId,
      version: options.version,
      pid,
      token: "diagnostic-noop",
      startedAt: now(),
      dbFile: options.home.dbFile,
      viewerPort: options.viewerPort,
    };
    return {
      lockDir,
      owner: noopOwner,
      release() {
        // No-op: diagnostic mode doesn't hold a lock
      },
    };
  }

  const ownerFile = path.join(lockDir, OWNER_FILENAME);
  const unwrittenOwnerStaleMs =
    options.unwrittenOwnerStaleMs ?? UNWRITTEN_OWNER_STALE_MS;

  fs.mkdirSync(options.home.daemonDir, { recursive: true });

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;

      const owner = readOwner(ownerFile);
      if (owner && pidIsAlive(owner.pid)) {
        throw new DuplicateOpenClawRuntimeError(lockDir, owner);
      }
      if (!owner && !lockLooksStale(lockDir, now(), unwrittenOwnerStaleMs)) {
        throw new DuplicateOpenClawRuntimeError(lockDir, null);
      }

      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  const owner: OpenClawRuntimeLockOwner = {
    pluginId: options.pluginId,
    version: options.version,
    pid,
    token: randomUUID(),
    startedAt: now(),
    dbFile: options.home.dbFile,
    viewerPort: options.viewerPort,
  };

  try {
    fs.writeFileSync(ownerFile, JSON.stringify(owner, null, 2), "utf8");
  } catch (err) {
    fs.rmSync(lockDir, { recursive: true, force: true });
    throw err;
  }

  let released = false;
  const releaseSync = () => {
    if (released) return;
    released = true;
    const current = readOwner(ownerFile);
    if (current?.token !== owner.token) return;
    fs.rmSync(lockDir, { recursive: true, force: true });
  };
  const onExit = () => releaseSync();
  process.once("exit", onExit);

  return {
    lockDir,
    owner,
    release() {
      releaseSync();
      process.off("exit", onExit);
    },
  };
}

function readOwner(ownerFile: string): OpenClawRuntimeLockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as Partial<OpenClawRuntimeLockOwner>;
    if (
      typeof parsed.pluginId !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.token !== "string" ||
      typeof parsed.startedAt !== "number" ||
      typeof parsed.dbFile !== "string" ||
      typeof parsed.viewerPort !== "number"
    ) {
      return null;
    }
    return parsed as OpenClawRuntimeLockOwner;
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function lockLooksStale(lockDir: string, now: number, staleMs: number): boolean {
  try {
    const stat = fs.statSync(lockDir);
    return now - stat.mtimeMs >= staleMs;
  } catch {
    return true;
  }
}
