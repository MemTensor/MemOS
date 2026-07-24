import { ids } from "../id.js";
import type { Logger } from "../logger/types.js";
import type {
  EvolutionJob,
  EvolutionJobType,
  makeEvolutionJobsRepo,
} from "../storage/repos/evolution_jobs.js";
import { EVOLUTION_JOB_TYPES } from "../storage/repos/evolution_jobs.js";

type EvolutionJobsRepo = ReturnType<typeof makeEvolutionJobsRepo>;

export interface EvolutionJobInput {
  jobType: EvolutionJobType;
  dedupeKey: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  availableAt?: number;
  preserveTerminal?: boolean;
}

export interface EvolutionWorker {
  start(): void;
  stop(): void;
  enqueue(input: EvolutionJobInput): EvolutionJob;
  /** Persist without waking; used inside a wider transaction. */
  persist(input: EvolutionJobInput): EvolutionJob;
  /** Wake a started worker after another transaction/process persisted work. */
  notify(): void;
  flush(): Promise<void>;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export function createEvolutionWorker(deps: {
  repo: EvolutionJobsRepo;
  log: Logger;
  execute(job: EvolutionJob): Promise<void>;
  now?: () => number;
  leaseMs?: number;
  heartbeatMs?: number;
  /** Portable SQLite poll interval used to discover cross-process inserts. */
  externalPollMs?: number;
  retryBackoffMs?: (attempt: number) => number;
}): EvolutionWorker {
  const now = deps.now ?? Date.now;
  // Model calls may legitimately run for 1,800 seconds. A renewable lease
  // prevents duplicate execution for arbitrarily long calls without making a
  // crashed owner block recovery for hours.
  const leaseMs = deps.leaseMs ?? 5 * 60_000;
  const heartbeatMs = deps.heartbeatMs ?? Math.min(30_000, Math.floor(leaseMs / 3));
  const externalPollMs = Math.max(1, Math.floor(deps.externalPollMs ?? 1_000));
  const retryBackoffMs = deps.retryBackoffMs ?? defaultBackoffMs;
  const workerId = `evolution-${ids.span()}`;
  let running: Promise<void> | null = null;
  let started = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let exclusiveTail: Promise<void> = Promise.resolve();

  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = exclusiveTail.then(operation, operation);
    exclusiveTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function persist(input: EvolutionJobInput): EvolutionJob {
    return deps.repo.enqueue({ ...input, now: now() });
  }

  async function processReady(): Promise<void> {
    while (!stopped) {
      const at = now();
      const [job] = deps.repo.leaseDue({
        workerId,
        now: at,
        leaseUntil: at + leaseMs,
        supportedJobTypes: EVOLUTION_JOB_TYPES,
        limit: 1,
      });
      if (!job) break;
      let leaseUntil = job.leaseUntil!;
      const heartbeat = setInterval(() => {
        try {
          const renewedAt = now();
          const nextLeaseUntil = renewedAt + leaseMs;
          const renewed = deps.repo.renewClaimed(job.id, {
            workerId,
            leaseUntil,
            nextLeaseUntil,
            now: renewedAt,
          });
          if (renewed) {
            leaseUntil = nextLeaseUntil;
          } else {
            deps.log.warn("evolution.job.lease_lost", {
              jobId: job.id,
              jobType: job.jobType,
              workerId,
            });
          }
        } catch (err) {
          deps.log.warn("evolution.job.lease_renew_failed", {
            jobId: job.id,
            jobType: job.jobType,
            workerId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }, Math.max(1, heartbeatMs));
      heartbeat.unref?.();
      try {
        await runExclusive(() => deps.execute(job));
        clearInterval(heartbeat);
        const result = deps.repo.completeClaimed(job.id, {
          workerId,
          leaseUntil,
          now: now(),
        });
        deps.log.info("evolution.job.completed", {
          jobId: job.id,
          jobType: job.jobType,
          attempts: job.attempts,
          result,
        });
      } catch (err) {
        clearInterval(heartbeat);
        const message = err instanceof Error ? err.message : String(err);
        const failed = deps.repo.failClaimed({
          id: job.id,
          workerId,
          leaseUntil,
          error: message,
          nextAttemptAt: now() + retryBackoffMs(job.attempts),
          now: now(),
        });
        deps.log.error("evolution.job.failed", {
          jobId: job.id,
          jobType: job.jobType,
          attempts: job.attempts,
          status: failed,
          err: { message },
        });
      }
    }
  }

  function schedule(): void {
    if (!started || stopped || running) return;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    running = processReady().finally(() => {
      running = null;
      scheduleNextDue();
    });
  }

  function scheduleNextDue(): void {
    if (stopped || running || retryTimer) return;
    const dueAt = deps.repo.nextAvailableAt(EVOLUTION_JOB_TYPES);
    // SQLite has no portable cross-process notification API. A short,
    // unref'ed poll works unchanged on Windows/macOS/Linux and lets a Hermes
    // stdio worker discover jobs written earlier by its viewer daemon.
    const delay = dueAt === null
      ? externalPollMs
      : Math.min(externalPollMs, Math.max(0, dueAt - now()));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      schedule();
    }, delay);
    retryTimer.unref?.();
  }

  return {
    start() {
      if (!stopped) {
        started = true;
        const recovered = deps.repo.recoverLeases(now());
        if (recovered > 0) deps.log.warn("evolution.leases.recovered", { recovered });
        schedule();
      }
    },
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
    enqueue(input) {
      const job = persist(input);
      schedule();
      return job;
    },
    persist,
    notify() {
      schedule();
    },
    async flush() {
      schedule();
      while (running) await running;
      await exclusiveTail;
    },
    runExclusive,
  };
}

function defaultBackoffMs(attempt: number): number {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}
