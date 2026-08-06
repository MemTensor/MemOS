import { EventEmitter } from "node:events";

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
});
