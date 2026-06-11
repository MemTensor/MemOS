import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedHome } from "../../../core/config/index.js";
import {
  acquireOpenClawRuntimeLock,
  DuplicateOpenClawRuntimeError,
  openClawRuntimeLockDir,
} from "../../../adapters/openclaw/runtime-lock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tmpHome(): ResolvedHome {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memos-oc-lock-"));
  roots.push(root);
  return {
    root,
    configFile: path.join(root, "config.yaml"),
    dataDir: path.join(root, "data"),
    dbFile: path.join(root, "data", "memos.db"),
    skillsDir: path.join(root, "skills"),
    logsDir: path.join(root, "logs"),
    daemonDir: path.join(root, "daemon"),
  };
}

function acquire(home: ResolvedHome, pid = process.pid, skipLock = false) {
  return acquireOpenClawRuntimeLock({
    home,
    pluginId: "memos-local-plugin",
    version: "test",
    viewerPort: 18799,
    pid,
    now: () => 1_700_000_000_000,
    unwrittenOwnerStaleMs: 0,
    skipLock,
  });
}

describe("OpenClaw runtime lock", () => {
  it("creates an owner record and releases the lock directory", () => {
    const home = tmpHome();
    const lock = acquire(home);
    const ownerPath = path.join(lock.lockDir, "owner.json");

    expect(fs.existsSync(ownerPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(ownerPath, "utf8"))).toMatchObject({
      pluginId: "memos-local-plugin",
      version: "test",
      pid: process.pid,
      dbFile: home.dbFile,
      viewerPort: 18799,
    });

    lock.release();
    expect(fs.existsSync(lock.lockDir)).toBe(false);
  });

  it("rejects a second live owner before another runtime can bootstrap", () => {
    const home = tmpHome();
    const lock = acquire(home);

    expect(() => acquire(home)).toThrow(DuplicateOpenClawRuntimeError);
    expect(fs.existsSync(path.join(lock.lockDir, "owner.json"))).toBe(true);

    lock.release();
  });

  it("reclaims a stale owner whose process is gone", () => {
    const home = tmpHome();
    const lockDir = openClawRuntimeLockDir(home);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pluginId: "memos-local-plugin",
        version: "old",
        pid: 99_999_999,
        token: "stale-token",
        startedAt: 1,
        dbFile: home.dbFile,
        viewerPort: 18799,
      }),
      "utf8",
    );

    const lock = acquire(home);
    expect(lock.owner.pid).toBe(process.pid);
    expect(lock.owner.token).not.toBe("stale-token");

    lock.release();
  });

  it("allows diagnostic mode to skip lock when gateway is running", () => {
    const home = tmpHome();
    const gatewayLock = acquire(home, process.pid, false);

    // Diagnostic mode should not throw even though gateway lock exists
    const diagnosticLock = acquire(home, process.pid + 1, true);
    expect(diagnosticLock.owner.token).toBe("diagnostic-noop");

    // Gateway lock file should still exist
    const ownerPath = path.join(gatewayLock.lockDir, "owner.json");
    expect(fs.existsSync(ownerPath)).toBe(true);

    // Diagnostic release is a no-op
    diagnosticLock.release();
    expect(fs.existsSync(ownerPath)).toBe(true);

    // Gateway release cleans up
    gatewayLock.release();
    expect(fs.existsSync(gatewayLock.lockDir)).toBe(false);
  });

  it("diagnostic mode does not create lock files", () => {
    const home = tmpHome();
    const lock = acquire(home, process.pid, true);
    const lockDir = openClawRuntimeLockDir(home);

    // Lock directory should not be created in diagnostic mode
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(lock.owner.token).toBe("diagnostic-noop");

    lock.release();
    expect(fs.existsSync(lockDir)).toBe(false);
  });
});
