import { afterEach, describe, expect, it, vi } from "vitest";

import { createStdioHostLlmBridge } from "../../../bridge/host-llm.js";

describe("stdio host LLM bridge", () => {
  afterEach(() => vi.useRealTimers());

  it("caps reverse RPC at the remaining deadline and forwards cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const controller = new AbortController();
    const serverRequest = vi.fn(async () => ({
      text: "host response",
      model: "host-model",
      durationMs: 10,
    }));
    const bridge = createStdioHostLlmBridge("test.host.v1", () => ({ serverRequest }));

    const result = await bridge.complete({
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 10_000,
      deadlineAt: Date.now() + 2_000,
      signal: controller.signal,
    });

    expect(result.text).toBe("host response");
    expect(serverRequest).toHaveBeenCalledWith(
      "host.llm.complete",
      expect.objectContaining({ timeoutMs: 2_000 }),
      { timeoutMs: 2_000, signal: controller.signal },
    );
  });

  it("rejects an expired deadline without sending reverse RPC", async () => {
    const serverRequest = vi.fn();
    const bridge = createStdioHostLlmBridge("test.host.v1", () => ({ serverRequest }));

    await expect(
      bridge.complete({
        messages: [{ role: "user", content: "hello" }],
        deadlineAt: Date.now() - 1,
      }),
    ).rejects.toThrow("deadline has passed");
    expect(serverRequest).not.toHaveBeenCalled();
  });

  it("rejects before stdio is ready", async () => {
    const bridge = createStdioHostLlmBridge("test.host.v1", () => null);

    await expect(
      bridge.complete({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toThrow("before stdio server was ready");
  });
});
