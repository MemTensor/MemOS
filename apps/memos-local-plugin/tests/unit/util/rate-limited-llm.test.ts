import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeepWindowQueue } from "../../../core/pipeline/deep-window.js";
import { initTestLogger, rootLogger } from "../../../core/logger/index.js";
import { createForegroundResources } from "../../../core/util/foreground-resources.js";
import { rateLimitLlmClient } from "../../../core/util/rate-limited-llm.js";
import { createSemaphore } from "../../../core/util/semaphore.js";
import { fakeLlm } from "../../helpers/fake-llm.js";

afterEach(() => vi.useRealTimers());

describe("background LLM window admission", () => {
  it.each(["complete", "completeJson", "stream"] as const)(
    "rechecks the window after acquiring a permit for %s",
    async (method) => {
      initTestLogger();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-05T05:59:59Z"));
      const gate = createDeepWindowQueue({
        kv: { get: (_key, fallback) => fallback, set: () => {} },
        config: { mode: "window", window: "02:00-06:00", timezone: "UTC", drainIntervalSec: 600, maxBatchPerCycle: 10 },
        log: rootLogger,
      });
      const semaphore = createSemaphore(1);
      const release = await semaphore.acquire();
      const inner = fakeLlm({ complete: { default: "ok" }, completeJson: { default: {} } });
      const called = vi.spyOn(inner, method);
      const client = rateLimitLlmClient(inner, semaphore, undefined, gate)!;
      const request = method === "stream"
        ? (async () => { for await (const _chunk of client.stream("test")) { /* consume */ } })()
        : client[method]("test");
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(new Date("2026-09-05T06:00:01Z"));
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(called).not.toHaveBeenCalled();

      // A waiting evolution request must not occupy the shared lite-capture budget.
      const lite = rateLimitLlmClient(inner, semaphore)!;
      await expect(lite.complete("test")).resolves.toMatchObject({ text: "ok" });
      called.mockClear();
      vi.setSystemTime(new Date("2026-09-06T02:00:00Z"));
      await vi.advanceTimersByTimeAsync(60_000);
      await request;
      expect(called).toHaveBeenCalledTimes(1);
    },
  );

  it("cancels a closed-window wait during pipeline shutdown", async () => {
    initTestLogger();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T14:00:00Z"));
    const gate = createDeepWindowQueue({
      kv: { get: (_key, fallback) => fallback, set: () => {} },
      config: { mode: "window", window: "02:00-06:00", timezone: "UTC", drainIntervalSec: 600, maxBatchPerCycle: 10 },
      log: rootLogger,
    });
    const resources = createForegroundResources();
    const inner = fakeLlm({ complete: { default: "ok" } });
    const client = rateLimitLlmClient(inner, createSemaphore(1), resources, gate)!;
    const request = client.complete("test");
    const cancelled = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    resources.shutdown();
    await cancelled;
    expect(inner.stats().requests).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
