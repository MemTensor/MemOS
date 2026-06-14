import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "../src/shared/with-timeout";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the underlying value when the promise wins the race", async () => {
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 5));
    const racePromise = withTimeout(fast, 100, "test.fast");
    await vi.advanceTimersByTimeAsync(5);
    const result = await racePromise;
    expect(result).toBe("ok");
  });

  it("returns null when the timeout fires first (fail-open semantics)", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 100));
    const racePromise = withTimeout(slow, 10, "test.slow");
    await vi.advanceTimersByTimeAsync(10);
    const result = await racePromise;
    expect(result).toBeNull();
  });

  it("logs a warning on timeout via the supplied logger", async () => {
    const warn = vi.fn();
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 100));
    const racePromise = withTimeout(slow, 5, "test.warn", { warn });
    await vi.advanceTimersByTimeAsync(5);
    await racePromise;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("test.warn");
    expect(warn.mock.calls[0][0]).toContain("timed out");
  });

  it("does not time out when ms <= 0 (timeout disabled)", async () => {
    const p = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 5));
    const racePromise = withTimeout(p, 0, "test.disabled");
    await vi.advanceTimersByTimeAsync(5);
    const result = await racePromise;
    expect(result).toBe("done");
  });

  it("propagates rejections from the underlying promise unchanged", async () => {
    const failing = Promise.reject(new Error("boom"));
    await expect(withTimeout(failing, 100, "test.reject")).rejects.toThrow("boom");
  });

  it("simulates the auto-recall hang path: a 30s LLM call falls back well before completion", async () => {
    // Mimic a slow recall LLM that would hang the gateway critical path.
    const hangingLLM = new Promise<{ relevant: number[]; sufficient: boolean }>(
      (resolve) => setTimeout(() => resolve({ relevant: [1, 2], sufficient: true }), 30_000),
    );
    const racePromise = withTimeout(hangingLLM, 8000, "auto-recall.filter");
    // Advance just past the 8s timeout — the underlying 30s promise has not resolved yet.
    await vi.advanceTimersByTimeAsync(8001);
    const result = await racePromise;
    expect(result).toBeNull();
  });
});
