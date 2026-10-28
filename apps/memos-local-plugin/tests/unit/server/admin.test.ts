import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import {
  isSupervisorManagedProcess,
  registerAdminRoutes,
} from "../../../server/routes/admin.js";
import { Routes } from "../../../server/routes/registry.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

describe("admin lifecycle routes", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string) => {
      const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
      child.unref = vi.fn();
      if (command === "pkill") {
        queueMicrotask(() => child.emit("exit", 1));
      }
      return child;
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDbFixture(): { root: string; dbFile: string } {
    const root = mkdtempSync(join(tmpdir(), "memos-admin-clear-"));
    tempDirs.push(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const dbFile = join(dataDir, "memos.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      writeFileSync(dbFile + suffix, suffix || "db");
    }
    return { root, dbFile };
  }

  function makeResponse(): EventEmitter & { writableFinished: boolean } {
    return Object.assign(new EventEmitter(), { writableFinished: false });
  }

  it("lets the supervisor replace a managed Hermes viewer", async () => {
    const requestShutdown = vi.fn();
    const routes = new Routes();
    registerAdminRoutes(
      routes,
      { core: {} as MemoryCore },
      {
        agent: "hermes",
        lifecycle: { supervised: true, requestShutdown },
      },
    );

    const restart = routes.getExact("POST /api/v1/admin/restart");
    expect(restart).toBeDefined();

    const result = await restart!({} as never);

    expect(result).toMatchObject({ ok: true, restarting: true });
    expect(spawnMock).not.toHaveBeenCalledWith(
      "bash",
      expect.anything(),
      expect.anything(),
    );
    expect(requestShutdown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    expect(requestShutdown).toHaveBeenCalledOnce();
  });

  it("retains the detached replacement fallback for a portable Hermes viewer", async () => {
    const requestShutdown = vi.fn();
    const routes = new Routes();
    registerAdminRoutes(
      routes,
      { core: {} as MemoryCore },
      {
        agent: "hermes",
        lifecycle: { supervised: false, requestShutdown },
      },
    );

    const restart = routes.getExact("POST /api/v1/admin/restart");
    const result = await restart!({} as never);

    expect(result).toMatchObject({ ok: true, restarting: true });
    expect(spawnMock).toHaveBeenCalledWith(
      "bash",
      [
        "-c",
        expect.stringContaining("--agent=hermes --daemon"),
      ],
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
      }),
    );

    await vi.advanceTimersByTimeAsync(200);
    expect(requestShutdown).toHaveBeenCalledOnce();
  });

  it("shuts down a Windows Hermes viewer after returning restart instructions", async () => {
    const requestShutdown = vi.fn();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const routes = new Routes();
    const res = makeResponse();
    registerAdminRoutes(
      routes,
      { core: { shutdown } as unknown as MemoryCore },
      {
        agent: "hermes",
        instanceId: "viewer-old",
        lifecycle: { supervised: false, platform: "win32", requestShutdown },
      },
    );

    const restart = routes.getExact("POST /api/v1/admin/restart");
    const result = await restart!({ res } as never);

    expect(result).toMatchObject({
      ok: true,
      restarting: false,
      manualRestartRequired: true,
      platform: "win32",
      instanceId: "viewer-old",
      message: expect.not.stringContaining("Stop-Process"),
    });
    expect((result as { message: string }).message).toContain("20-30 seconds");
    expect((result as { message: string }).message).toContain("Hermes itself");
    expect((result as { message: string }).message).not.toContain("not the MemOS plugin");
    expect((result as { message: string }).message).toContain("Keep this page open");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requestShutdown).not.toHaveBeenCalled();

    res.writableFinished = true;
    res.emit("finish");
    await vi.advanceTimersByTimeAsync(299);
    expect(requestShutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(requestShutdown).toHaveBeenCalledOnce();
  });

  it("keeps Windows OpenClaw alive and returns manual gateway restart instructions", async () => {
    const requestShutdown = vi.fn();
    const routes = new Routes();
    registerAdminRoutes(
      routes,
      { core: {} as MemoryCore },
      {
        agent: "openclaw",
        lifecycle: { platform: "win32", requestShutdown },
      },
    );

    const restart = routes.getExact("POST /api/v1/admin/restart");
    const result = await restart!({} as never);

    expect(result).toMatchObject({
      ok: true,
      restarting: false,
      manualRestartRequired: true,
      platform: "win32",
      message: expect.stringContaining("openclaw gateway stop"),
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it("retains the supervised restart response for Unix OpenClaw", async () => {
    const routes = new Routes();
    registerAdminRoutes(
      routes,
      { core: {} as MemoryCore },
      { agent: "openclaw", lifecycle: { platform: "linux", supervised: true } },
    );

    const restart = routes.getExact("POST /api/v1/admin/restart");
    const result = await restart!({} as never);

    expect(result).toEqual({ ok: true, restarting: true });
  });

  it("requires a manual DSH profile restart without terminating the host", async () => {
    const requestShutdown = vi.fn();
    const routes = new Routes();
    registerAdminRoutes(
      routes,
      { core: {} as MemoryCore },
      {
        agent: "deepseek-harness",
        lifecycle: { platform: "darwin", requestShutdown },
      },
    );

    const restart = routes.getExact("POST /api/v1/admin/restart");
    const result = await restart!({} as never);

    expect(result).toMatchObject({
      ok: true,
      restarting: false,
      manualRestartRequired: true,
      message: expect.stringContaining("DeepSeek Harness"),
    });
    expect(spawnMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it("refuses in-process DSH clear-data without shutting down or spawning a daemon", async () => {
    const shutdown = vi.fn();
    const { root, dbFile } = makeDbFixture();
    const routes = new Routes();
    registerAdminRoutes(
      routes,
      { core: { shutdown } as unknown as MemoryCore, home: { root, dbFile } },
      { agent: "deepseek-harness", lifecycle: { platform: "darwin" } },
    );

    const clearData = routes.getExact("POST /api/v1/admin/clear-data");
    const result = await clearData!({} as never);

    expect(result).toMatchObject({
      ok: false,
      cleared: false,
      restarting: false,
      error: expect.stringContaining("disabled"),
    });
    expect(shutdown).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(existsSync(dbFile)).toBe(true);
  });

  it("refuses Windows clear-data while the Hermes bridge is still connected", async () => {
    const shutdown = vi.fn();
    const requestShutdown = vi.fn();
    const { root, dbFile } = makeDbFixture();
    const routes = new Routes();
    registerAdminRoutes(
      routes,
      {
        core: { shutdown } as unknown as MemoryCore,
        home: { root, dbFile },
        bridgeStatus: () => ({
          status: "connected",
          lastOkAt: Date.now(),
          lastErrorAt: null,
          lastError: null,
        }),
      },
      {
        agent: "hermes",
        lifecycle: { platform: "win32", requestShutdown },
      },
    );

    const clearData = routes.getExact("POST /api/v1/admin/clear-data");
    const result = await clearData!({} as never);

    expect(result).toMatchObject({
      ok: false,
      manualCloseRequired: true,
      platform: "win32",
    });
    expect(shutdown).not.toHaveBeenCalled();
    expect(requestShutdown).not.toHaveBeenCalled();
    expect(existsSync(dbFile)).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("clears Windows data only after Hermes disconnects and requests a manual restart", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const requestShutdown = vi.fn();
    const { root, dbFile } = makeDbFixture();
    writeFileSync(join(root, "bridge-status.json"), "{}");
    const routes = new Routes();
    const res = makeResponse();
    registerAdminRoutes(
      routes,
      {
        core: { shutdown } as unknown as MemoryCore,
        home: { root, dbFile },
        bridgeStatus: () => ({
          status: "disconnected",
          lastOkAt: null,
          lastErrorAt: Date.now(),
          lastError: "Hermes chat disconnected",
        }),
      },
      {
        agent: "hermes",
        lifecycle: { platform: "win32", requestShutdown },
      },
    );

    const clearData = routes.getExact("POST /api/v1/admin/clear-data");
    const result = await clearData!({ res } as never);

    expect(result).toMatchObject({
      ok: true,
      cleared: true,
      restarting: false,
      manualRestartRequired: true,
      platform: "win32",
    });
    expect(shutdown).toHaveBeenCalledOnce();
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(existsSync(dbFile + suffix)).toBe(false);
    }
    expect(existsSync(join(root, "bridge-status.json"))).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(requestShutdown).not.toHaveBeenCalled();

    res.writableFinished = true;
    res.emit("finish");
    res.emit("close");
    await vi.advanceTimersByTimeAsync(299);
    expect(requestShutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(requestShutdown).toHaveBeenCalledOnce();
  });

  it("does not report Windows clear-data success when a database path cannot be removed", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const requestShutdown = vi.fn();
    const root = mkdtempSync(join(tmpdir(), "memos-admin-clear-fail-"));
    tempDirs.push(root);
    const dbFile = join(root, "data", "memos.db");
    mkdirSync(dbFile, { recursive: true });
    const routes = new Routes();
    const res = makeResponse();
    registerAdminRoutes(
      routes,
      {
        core: { shutdown } as unknown as MemoryCore,
        home: { root, dbFile },
        bridgeStatus: () => ({
          status: "disconnected",
          lastOkAt: null,
          lastErrorAt: Date.now(),
          lastError: "Hermes chat disconnected",
        }),
      },
      {
        agent: "hermes",
        lifecycle: { platform: "win32", requestShutdown },
      },
    );

    const clearData = routes.getExact("POST /api/v1/admin/clear-data");
    const result = await clearData!({ res } as never);

    expect(result).toMatchObject({
      ok: false,
      cleared: false,
      manualRestartRequired: true,
      platform: "win32",
    });
    expect(String((result as { error?: unknown }).error)).toContain("memos.db");
    expect(spawnMock).not.toHaveBeenCalled();

    res.emit("close");
    await vi.advanceTimersByTimeAsync(999);
    expect(requestShutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(requestShutdown).toHaveBeenCalledOnce();
  });

  it("keeps the existing Unix clear-data replacement path", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const requestShutdown = vi.fn();
    const { root, dbFile } = makeDbFixture();
    const routes = new Routes();
    registerAdminRoutes(
      routes,
      { core: { shutdown } as unknown as MemoryCore, home: { root, dbFile } },
      {
        agent: "hermes",
        lifecycle: { platform: "linux", supervised: false, requestShutdown },
      },
    );

    const clearData = routes.getExact("POST /api/v1/admin/clear-data");
    const result = await clearData!({} as never);

    expect(result).toMatchObject({ ok: true, restarting: true });
    expect(spawnMock).toHaveBeenCalledWith(
      "bash",
      expect.anything(),
      expect.anything(),
    );
  });

  it("recognises launchd and systemd without treating the macOS shell sentinel as supervised", () => {
    expect(isSupervisorManagedProcess({ XPC_SERVICE_NAME: "ai.memtensor.memos-local-hermes" })).toBe(true);
    expect(isSupervisorManagedProcess({ XPC_SERVICE_NAME: "ai.memtensor.memos-local-hermes.nova" })).toBe(true);
    expect(isSupervisorManagedProcess({ INVOCATION_ID: "abc123" })).toBe(true);
    expect(isSupervisorManagedProcess({ XPC_SERVICE_NAME: "application.com.example.desktop" })).toBe(false);
    expect(isSupervisorManagedProcess({ JOURNAL_STREAM: "8:12345" })).toBe(false);
    expect(isSupervisorManagedProcess({ XPC_SERVICE_NAME: "0" })).toBe(false);
    expect(isSupervisorManagedProcess({})).toBe(false);
  });
});
