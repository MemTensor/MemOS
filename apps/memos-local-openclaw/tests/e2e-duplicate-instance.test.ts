/**
 * Real integration test: verify that calling register() twice stops the
 * previous viewer instead of leaking a second HTTP server on a new port.
 *
 * Spins up actual HTTP servers (ViewerServer) and verifies:
 *   1. Old instance is torn down before new one starts
 *   2. New viewer binds to the same port (not port+1)
 *   3. Only one HTTP server is running after re-registration
 */

import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-dup-test-"));
fs.mkdirSync(path.join(tmpDir, "memos-local"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "workspace", "skills"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "skills"), { recursive: true });

/** Find a free port by temporarily binding to port 0 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Check if a port is in use by attempting TCP connect */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

function createMockApi(stateDir: string, gatewayPort: number) {
  const services: Array<{ id: string; start: () => Promise<void>; stop: () => Promise<void> }> = [];
  const logs: string[] = [];
  return {
    api: {
      id: "memos-local-openclaw-plugin",
      pluginConfig: {},
      config: { gateway: { port: gatewayPort } },
      resolvePath: (p: string) => p.replace("~/.openclaw", stateDir),
      logger: {
        info: (msg: string) => logs.push(msg),
        warn: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
        debug: (msg: string) => logs.push(msg),
      },
      registerTool: () => {},
      registerMemoryCapability: () => {},
      registerService: (svc: any) => { services.push(svc); },
      registerHook: () => {},
      on: () => {},
    },
    services,
    logs,
  };
}

let lastCleanup: (() => Promise<void>) | null = null;

afterAll(async () => {
  if (lastCleanup) await lastCleanup();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Extract the viewer port from logs like "→ http://127.0.0.1:19799" */
function extractViewerPort(logs: string[]): number | null {
  for (const l of logs) {
    const m = l.match(/→\s*http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

describe("duplicate instance prevention (real HTTP servers)", () => {
  it("second register() should stop previous viewer and reuse the same port", async () => {
    // Pick a random free port to avoid collisions with other processes
    const freePort = await findFreePort();
    const gatewayPort = freePort;
    const expectedViewerPort = gatewayPort + 10;

    // Confirm our ports are actually free
    expect(await isPortListening(expectedViewerPort)).toBe(false);
    expect(await isPortListening(expectedViewerPort + 1)).toBe(false);

    const pluginModule = await import("../index");
    const plugin = pluginModule.default;

    // ─── 1st register + start ───
    const mock1 = createMockApi(tmpDir, gatewayPort);
    plugin.register(mock1.api as any);
    const svc1 = mock1.services[mock1.services.length - 1];
    await svc1.start();

    const viewerPort1 = extractViewerPort(mock1.logs);
    expect(viewerPort1).toBe(expectedViewerPort);
    expect(await isPortListening(expectedViewerPort)).toBe(true);

    // ─── 2nd register (simulates deferred reload / gateway restart) ───
    const mock2 = createMockApi(tmpDir, gatewayPort);
    plugin.register(mock2.api as any);

    // Verify the plugin detected the previous instance
    const detectedMsg = mock2.logs.some((l) => l.includes("previous instance detected"));
    expect(detectedMsg).toBe(true);

    // Start the 2nd service — cleanup happens inside startServiceCore()
    const svc2 = mock2.services[mock2.services.length - 1];
    await svc2.start();

    lastCleanup = async () => { await svc2.stop(); };

    // Verify: stopped previous, then started on the SAME port
    const stoppedMsg = mock2.logs.some((l) => l.includes("previous instance stopped"));
    expect(stoppedMsg).toBe(true);

    const viewerPort2 = extractViewerPort(mock2.logs);
    expect(viewerPort2).toBe(expectedViewerPort);  // Same port, not port+1

    // Verify: only ONE server is running (the expected port), not two
    expect(await isPortListening(expectedViewerPort)).toBe(true);
    expect(await isPortListening(expectedViewerPort + 1)).toBe(false);

    // ─── Clean stop ───
    await svc2.stop();
    lastCleanup = null;
    await new Promise((r) => setTimeout(r, 200));

    expect(await isPortListening(expectedViewerPort)).toBe(false);
  });
});
