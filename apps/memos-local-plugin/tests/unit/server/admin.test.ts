import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import {
  isSupervisorManagedProcess,
  isWindowsPlatform,
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
  });

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
        platform: "linux",
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

  it("recognises launchd and systemd without treating the macOS shell sentinel as supervised", () => {
    expect(isSupervisorManagedProcess({ XPC_SERVICE_NAME: "ai.memtensor.memos-local-hermes" })).toBe(true);
    expect(isSupervisorManagedProcess({ XPC_SERVICE_NAME: "ai.memtensor.memos-local-hermes.nova" })).toBe(true);
    expect(isSupervisorManagedProcess({ INVOCATION_ID: "abc123" })).toBe(true);
    expect(isSupervisorManagedProcess({ XPC_SERVICE_NAME: "application.com.example.desktop" })).toBe(false);
    expect(isSupervisorManagedProcess({ JOURNAL_STREAM: "8:12345" })).toBe(false);
    expect(isSupervisorManagedProcess({ XPC_SERVICE_NAME: "0" })).toBe(false);
    expect(isSupervisorManagedProcess({})).toBe(false);
  });

  it("recognises Windows via the isWindowsPlatform helper", () => {
    expect(isWindowsPlatform("win32")).toBe(true);
    expect(isWindowsPlatform("linux")).toBe(false);
    expect(isWindowsPlatform("darwin")).toBe(false);
  });

  it("refuses restart on Windows portable and never kills the daemon", async () => {
    const requestShutdown = vi.fn();
    const routes = new Routes();
    registerAdminRoutes(
      routes,
      { core: {} as MemoryCore },
      {
        agent: "hermes",
        lifecycle: { supervised: false, requestShutdown },
        platform: "win32",
      },
    );

    const restart = routes.getExact("POST /api/v1/admin/restart");
    expect(restart).toBeDefined();

    const result = await restart!({} as never);

    expect(result).toMatchObject({
      ok: false,
      restarting: false,
      manualRestartRequired: true,
    });
    // No pkill, no bash — those are what corrupt the flow on Windows.
    expect(spawnMock).not.toHaveBeenCalled();

    // Advance past every scheduled shutdown window; the daemon must stay alive.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it("still self-shuts on Windows when a supervisor is present", async () => {
    const requestShutdown = vi.fn();
    const routes = new Routes();
    registerAdminRoutes(
      routes,
      { core: {} as MemoryCore },
      {
        agent: "hermes",
        lifecycle: { supervised: true, requestShutdown },
        platform: "win32",
      },
    );

    const restart = routes.getExact("POST /api/v1/admin/restart");
    const result = await restart!({} as never);

    expect(result).toMatchObject({ ok: true, restarting: true });
    // Even on Windows, when a supervisor exists (e.g. NSSM-wrapped service),
    // shutting down is safe because the supervisor respawns us.
    expect(spawnMock).not.toHaveBeenCalledWith(
      "bash",
      expect.anything(),
      expect.anything(),
    );

    await vi.advanceTimersByTimeAsync(200);
    expect(requestShutdown).toHaveBeenCalledOnce();
  });

  it("clear-data on Windows portable wipes DB files without killing the daemon", async () => {
    const requestShutdown = vi.fn();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const routes = new Routes();

    registerAdminRoutes(
      routes,
      {
        core: { shutdown } as unknown as MemoryCore,
        home: {
          root: "/does/not/exist/nowhere",
          dbFile: "/does/not/exist/nowhere/db.sqlite",
        },
      },
      {
        agent: "hermes",
        lifecycle: { supervised: false, requestShutdown },
        platform: "win32",
      },
    );

    const clear = routes.getExact("POST /api/v1/admin/clear-data");
    expect(clear).toBeDefined();
    const result = await clear!({} as never);

    expect(result).toMatchObject({
      ok: true,
      restarting: false,
      manualRestartRequired: true,
    });
    // pkill was not attempted, bash was not attempted.
    expect(spawnMock).not.toHaveBeenCalled();
    // MemoryCore.shutdown() still fires so SQLite handles are released
    // before the user manually restarts Hermes.
    expect(shutdown).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestShutdown).not.toHaveBeenCalled();
  });
});
