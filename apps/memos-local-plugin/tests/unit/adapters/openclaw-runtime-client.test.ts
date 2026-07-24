import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedHome } from "../../../core/config/index.js";
import type { SocketClient } from "../../../bridge/socket.js";

const mocks = vi.hoisted(() => ({
  connectSocketClient: vi.fn(),
  inspectOpenClawRuntimeLock: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../../../bridge/socket.js", () => ({
  connectSocketClient: mocks.connectSocketClient,
}));

vi.mock("../../../adapters/openclaw/runtime-lock.js", () => ({
  inspectOpenClawRuntimeLock: mocks.inspectOpenClawRuntimeLock,
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

import {
  connectSharedOpenClawRuntime,
} from "../../../adapters/openclaw/runtime-client.js";
import {
  IncompatibleOpenClawRuntimeError,
  OPENCLAW_RUNTIME_PROTOCOL,
  RuntimeWriteOutcomeUnknownError,
} from "../../../adapters/openclaw/runtime-protocol.js";

const roots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tmpHome(): ResolvedHome {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memos-runtime-client-"));
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

function compatibleHealth(home: ResolvedHome) {
  return {
    ok: true,
    agent: "openclaw",
    paths: { db: home.dbFile },
    runtime: {
      protocolMajor: OPENCLAW_RUNTIME_PROTOCOL.major,
      protocolMinor: OPENCLAW_RUNTIME_PROTOCOL.minor,
      pluginVersion: "test",
      capabilities: [...OPENCLAW_RUNTIME_PROTOCOL.requiredCapabilities],
    },
  };
}

function socket(
  request: (method: string, params?: unknown) => unknown | Promise<unknown>,
): SocketClient & { request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  let connected = true;
  const close = vi.fn(() => {
    connected = false;
  });
  return {
    get connected() {
      return connected;
    },
    request: vi.fn(request),
    close,
  };
}

describe("OpenClaw shared runtime client", () => {
  it("reconnects and replays a read after transport failure", async () => {
    const home = tmpHome();
    const first = socket(async (method) => {
      if (method === "core.health") return compatibleHealth(home);
      throw new Error("MemOS runtime socket closed");
    });
    const second = socket(async (method) => {
      if (method === "core.health") return compatibleHealth(home);
      if (method === "memory.get_trace") return { id: "trace-1" };
      throw new Error(`unexpected method ${method}`);
    });
    mocks.connectSocketClient
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const client = await connectSharedOpenClawRuntime(home);

    await expect(client.request("memory.get_trace", { id: "trace-1" }))
      .resolves.toEqual({ id: "trace-1" });
    expect(second.request).toHaveBeenCalledWith(
      "memory.get_trace",
      { id: "trace-1" },
      undefined,
    );
  });

  it("reconnects but never replays a write with an unknown outcome", async () => {
    const home = tmpHome();
    const first = socket(async (method) => {
      if (method === "core.health") return compatibleHealth(home);
      throw new Error("MemOS runtime socket closed");
    });
    const second = socket(async (method) => {
      if (method === "core.health") return compatibleHealth(home);
      throw new Error(`write unexpectedly replayed: ${method}`);
    });
    mocks.connectSocketClient
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const client = await connectSharedOpenClawRuntime(home);

    await expect(client.request("feedback.submit", { rationale: "once" }))
      .rejects.toBeInstanceOf(RuntimeWriteOutcomeUnknownError);
    await vi.waitFor(() => {
      expect(second.request).toHaveBeenCalledWith(
        "core.health",
        undefined,
        { timeoutMs: 5_000 },
      );
    });
    expect(second.request).not.toHaveBeenCalledWith(
      "feedback.submit",
      expect.anything(),
      expect.anything(),
    );
  });

  it("reports a timed-out write as outcome-unknown without replaying it", async () => {
    const home = tmpHome();
    const timedOut = socket(async (method) => {
      if (method === "core.health") return compatibleHealth(home);
      throw Object.assign(
        new Error(`MemOS RPC ${method} timed out after 25000ms`),
        { code: "rpc_timeout" },
      );
    });
    mocks.connectSocketClient.mockResolvedValueOnce(timedOut);

    const client = await connectSharedOpenClawRuntime(home);

    await expect(client.request("turn.end", { episodeId: "ep-timeout" }))
      .rejects.toBeInstanceOf(RuntimeWriteOutcomeUnknownError);
    expect(timedOut.request).toHaveBeenCalledTimes(2);
  });

  it("fails fast instead of connecting to a legacy daemon", async () => {
    const home = tmpHome();
    const legacy = socket(async () => ({
      ok: true,
      agent: "openclaw",
      paths: { db: home.dbFile },
    }));
    mocks.connectSocketClient.mockResolvedValueOnce(legacy);

    await expect(connectSharedOpenClawRuntime(home))
      .rejects.toBeInstanceOf(IncompatibleOpenClawRuntimeError);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("spawns a new owner after the previous live owner releases its lock", async () => {
    const home = tmpHome();
    const ready = socket(async (method) => {
      if (method === "core.health") return compatibleHealth(home);
      throw new Error(`unexpected method ${method}`);
    });
    mocks.connectSocketClient
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockResolvedValueOnce(ready);
    mocks.inspectOpenClawRuntimeLock
      .mockReturnValueOnce({ owner: { pid: 10 }, alive: true })
      .mockReturnValueOnce({ owner: null, alive: false });
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = vi.fn();
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    const client = await connectSharedOpenClawRuntime(home);

    expect(client.connected).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.inspectOpenClawRuntimeLock).toHaveBeenCalledTimes(2);
  });
});
