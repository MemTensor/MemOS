import { describe, expect, it, vi } from "vitest";

import { createSkillLifecycleWorker } from "../../../core/skill/lifecycle-worker.js";
import { rootLogger } from "../../../core/logger/index.js";

describe("skill/lifecycle-worker", () => {
  it("runs immediately, stays single-flight, and continues on its interval", async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst!: () => void;
      const firstRun = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const runLifecycle = vi
        .fn<() => Promise<void>>()
        .mockReturnValueOnce(firstRun)
        .mockResolvedValue(undefined);
      const worker = createSkillLifecycleWorker({
        runLifecycle,
        log: rootLogger.child({ channel: "test.skill.lifecycle-worker" }),
        intervalMs: 1_000,
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(runLifecycle).toHaveBeenCalledTimes(1);

      releaseFirst();
      await worker.flush();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runLifecycle).toHaveBeenCalledTimes(2);
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs scheduled failures and retries on the next interval", async () => {
    vi.useFakeTimers();
    try {
      const log = rootLogger.child({ channel: "test.skill.lifecycle-worker" });
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const runLifecycle = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("scan failed"))
        .mockResolvedValue(undefined);
      const worker = createSkillLifecycleWorker({
        runLifecycle,
        log,
        intervalMs: 1_000,
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledWith("skill.lifecycle_worker.failed", {
        err: "scan failed",
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(runLifecycle).toHaveBeenCalledTimes(2);
      worker.stop();
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops scheduled runs while allowing an explicit final run", async () => {
    vi.useFakeTimers();
    try {
      const runLifecycle = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const worker = createSkillLifecycleWorker({
        runLifecycle,
        log: rootLogger.child({ channel: "test.skill.lifecycle-worker" }),
        intervalMs: 1_000,
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      worker.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runLifecycle).toHaveBeenCalledTimes(1);

      await worker.runNow();
      expect(runLifecycle).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
