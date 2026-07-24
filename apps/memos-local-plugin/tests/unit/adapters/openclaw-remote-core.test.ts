import { describe, expect, it, vi } from "vitest";

import { createRemoteMemoryCore } from "../../../adapters/openclaw/remote-core.js";
import type { OpenClawRuntimeCore } from "../../../adapters/openclaw/runtime-core.js";
import type { SocketClient } from "../../../bridge/socket.js";

function clientStub(): SocketClient & { request: ReturnType<typeof vi.fn> } {
  return {
    connected: true,
    request: vi.fn(async (method: string) => {
      if (method === "session.open") return { sessionId: "s1" };
      if (method === "skill.list") return { skills: [{ id: "skill-1" }] };
      if (method === "memory.timeline") return { traces: [{ id: "trace-1" }] };
      return { ok: true };
    }),
    close: vi.fn(),
  };
}

describe("OpenClaw remote MemoryCore", () => {
  it("exposes only the OpenClaw hook and tool contract", () => {
    const core: OpenClawRuntimeCore = createRemoteMemoryCore(clientStub());

    expect("deleteTrace" in core).toBe(false);
    expect("patchConfig" in core).toBe(false);
    expect("exportBundle" in core).toBe(false);
    expect("rebuildEmbeddings" in core).toBe(false);
  });

  it("unwraps shared-runtime responses used by hooks and tools", async () => {
    const client = clientStub();
    const core = createRemoteMemoryCore(client);

    await expect(core.openSession({ agent: "openclaw" })).resolves.toBe("s1");
    await expect(core.listSkills()).resolves.toEqual([{ id: "skill-1" }]);
    await expect(core.timeline({ episodeId: "ep-1" })).resolves.toEqual([
      { id: "trace-1" },
    ]);
  });

  it("keeps turn completion below OpenClaw's agent_end deadline", async () => {
    const client = clientStub();
    const core = createRemoteMemoryCore(client);

    await core.onTurnEnd({} as never);

    expect(client.request).toHaveBeenCalledWith(
      "turn.end",
      {},
      { timeoutMs: 25_000 },
    );
  });

  it("forwards synchronous tool observations without blocking OpenClaw", () => {
    const client = clientStub();
    const core = createRemoteMemoryCore(client);

    const result = core.recordToolOutcome({
      sessionId: "s1",
      tool: "exec",
      success: true,
      durationMs: 5,
      ts: 10,
    });

    expect(result).toBeUndefined();
    expect(client.request).toHaveBeenCalledWith(
      "tool_outcome.record",
      expect.objectContaining({ sessionId: "s1", tool: "exec" }),
    );
  });
});
