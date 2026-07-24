import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import {
  connectSocketClient,
  startSocketServer,
} from "../../../bridge/socket.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function socketPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memos-socket-test-"));
  roots.push(root);
  return path.join(root, "runtime.sock");
}

function stubCore(): MemoryCore {
  return {
    health: vi.fn(async () => ({ ok: true, version: "test" })),
    openSession: vi.fn(async ({ sessionId }) => sessionId ?? "generated"),
    recordToolOutcome: vi.fn(),
  } as unknown as MemoryCore;
}

describe("local runtime socket", () => {
  it("serves multiple concurrent clients from one MemoryCore", async () => {
    const core = stubCore();
    const endpoint = socketPath();
    const server = await startSocketServer({ core, socketPath: endpoint });
    const [clientA, clientB] = await Promise.all([
      connectSocketClient(endpoint),
      connectSocketClient(endpoint),
    ]);

    const [a, b] = await Promise.all([
      clientA.request<{ sessionId: string }>("session.open", {
        agent: "openclaw",
        sessionId: "a",
      }),
      clientB.request<{ sessionId: string }>("session.open", {
        agent: "openclaw",
        sessionId: "b",
      }),
    ]);

    expect(a.sessionId).toBe("a");
    expect(b.sessionId).toBe("b");
    expect(core.openSession).toHaveBeenCalledTimes(2);
    expect(server.connectionCount).toBe(2);

    clientA.close();
    clientB.close();
    await server.close();
  });

  it("forwards tool outcomes to the owner core", async () => {
    const core = stubCore();
    const endpoint = socketPath();
    const server = await startSocketServer({ core, socketPath: endpoint });
    const client = await connectSocketClient(endpoint);

    await client.request("tool_outcome.record", {
      sessionId: "s1",
      tool: "exec",
      success: true,
      durationMs: 5,
      ts: 10,
    });

    expect(core.recordToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", tool: "exec" }),
    );

    client.close();
    await server.close();
  });
});
