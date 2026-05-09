import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "../src/shared/with-timeout";

describe("withTimeout", () => {
  it("resolves with the underlying value when the promise wins the race", async () => {
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 5));
    const result = await withTimeout(fast, 100, "test.fast");
    expect(result).toBe("ok");
  });

  it("returns null when the timeout fires first (fail-open semantics)", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 100));
    const result = await withTimeout(slow, 10, "test.slow");
    expect(result).toBeNull();
  });

  it("logs a warning on timeout via the supplied logger", async () => {
    const warn = vi.fn();
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 100));
    await withTimeout(slow, 5, "test.warn", { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("test.warn");
    expect(warn.mock.calls[0][0]).toContain("timed out");
  });

  it("does not time out when ms <= 0 (timeout disabled)", async () => {
    const p = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 5));
    const result = await withTimeout(p, 0, "test.disabled");
    expect(result).toBe("done");
  });

  it("propagates rejections from the underlying promise unchanged", async () => {
    const failing = Promise.reject(new Error("boom"));
    await expect(withTimeout(failing, 100, "test.reject")).rejects.toThrow("boom");
  });

  it("simulates the auto-recall hang path: a 30s LLM call falls back in 8s", async () => {
    // Mimic a slow recall LLM that would hang the gateway critical path.
    const hangingLLM = new Promise<{ relevant: number[]; sufficient: boolean }>(
      (resolve) => setTimeout(() => resolve({ relevant: [1, 2], sufficient: true }), 30_000),
    );
    const t0 = Date.now();
    const result = await withTimeout(hangingLLM, 50, "auto-recall.filter");
    const elapsed = Date.now() - t0;
    expect(result).toBeNull();
    // Must give up well under the 30s LLM completion time.
    expect(elapsed).toBeLessThan(500);
  });
});
