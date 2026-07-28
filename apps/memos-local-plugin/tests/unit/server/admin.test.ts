import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { registerAdminRoutes } from "../../../server/routes/admin.js";
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

  it("replaces the Hermes viewer daemon so saved model config takes effect", async () => {
    const routes = new Routes();
    registerAdminRoutes(
      routes,
      { core: {} as MemoryCore },
      { agent: "hermes" },
    );

    const restart = routes.getExact("POST /api/v1/admin/restart");
    expect(restart).toBeDefined();

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
  });
});
