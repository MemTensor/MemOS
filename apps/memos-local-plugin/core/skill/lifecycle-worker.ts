import type { Logger } from "../logger/types.js";

export const DEFAULT_SKILL_LIFECYCLE_INTERVAL_MS = 60 * 60 * 1000;

export interface SkillLifecycleWorker {
  start(): void;
  trigger(): void;
  runNow(): Promise<void>;
  flush(): Promise<void>;
  stop(): void;
}

export interface SkillLifecycleWorkerDeps {
  runLifecycle(): Promise<void>;
  log: Logger;
  intervalMs?: number;
  now?: () => number;
}

/**
 * Periodically runs lightweight Skill lifecycle maintenance without draining
 * the full capture/reward/L2/L3 pipeline. Scheduled failures are isolated so
 * one bad pass cannot permanently stop future maintenance.
 */
export function createSkillLifecycleWorker(
  deps: SkillLifecycleWorkerDeps,
): SkillLifecycleWorker {
  const intervalMs = Math.max(
    1,
    Math.floor(deps.intervalMs ?? DEFAULT_SKILL_LIFECYCLE_INTERVAL_MS),
  );
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let stopped = true;

  function beginRun(): Promise<void> {
    if (running) return running;
    lastStartedAt = now();
    const current = Promise.resolve().then(() => deps.runLifecycle()).finally(() => {
      if (running === current) running = null;
    });
    running = current;
    return current;
  }

  function trigger(): void {
    if (stopped || running || now() - lastStartedAt < intervalMs) return;
    void beginRun().catch((err) => {
      deps.log.warn("skill.lifecycle_worker.failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      trigger();
      timer = setInterval(trigger, intervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    },

    trigger,

    runNow(): Promise<void> {
      return beginRun();
    },

    async flush(): Promise<void> {
      if (running) await running;
    },

    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
