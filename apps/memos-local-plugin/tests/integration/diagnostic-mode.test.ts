/**
 * Integration test for diagnostic mode (openclaw doctor) behavior.
 *
 * Verifies that when OPENCLAW_DIAGNOSTIC_MODE is set, the plugin
 * can register even when a gateway instance is already holding the lock.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedHome } from "../../core/config/index.js";
import {
  acquireOpenClawRuntimeLock,
  DuplicateOpenClawRuntimeError,
} from "../../adapters/openclaw/runtime-lock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tmpHome(): ResolvedHome {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memos-diag-"));
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

describe("Diagnostic mode integration", () => {
  it("allows doctor process to run alongside gateway", () => {
    const home = tmpHome();

    // Simulate gateway acquiring lock
    const gatewayLock = acquireOpenClawRuntimeLock({
      home,
      pluginId: "memos-local-plugin",
      version: "2.0.6",
      viewerPort: 18799,
      pid: process.pid,
      skipLock: false,
    });

    expect(gatewayLock.owner.token).not.toBe("diagnostic-noop");

    // Simulate doctor process with skipLock
    const doctorLock = acquireOpenClawRuntimeLock({
      home,
      pluginId: "memos-local-plugin",
      version: "2.0.6",
      viewerPort: 18799,
      pid: process.pid + 1,
      skipLock: true,
    });

    expect(doctorLock.owner.token).toBe("diagnostic-noop");
    expect(() => doctorLock.release()).not.toThrow();

    gatewayLock.release();
  });

  it("still blocks duplicate gateway instances", () => {
    const home = tmpHome();

    const lock1 = acquireOpenClawRuntimeLock({
      home,
      pluginId: "memos-local-plugin",
      version: "2.0.6",
      viewerPort: 18799,
      pid: process.pid,
      skipLock: false,
    });

    expect(() => {
      acquireOpenClawRuntimeLock({
        home,
        pluginId: "memos-local-plugin",
        version: "2.0.6",
        viewerPort: 18799,
        pid: process.pid,
        skipLock: false,
      });
    }).toThrow(DuplicateOpenClawRuntimeError);

    lock1.release();
  });
});
