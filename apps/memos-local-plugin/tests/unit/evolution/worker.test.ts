import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEvolutionWorker } from "../../../core/evolution/worker.js";
import { rootLogger } from "../../../core/logger/index.js";
import { makeRepos, openDb, runMigrations } from "../../../core/storage/index.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

const NOW = 1_700_000_000_000;

describe("durable evolution worker", () => {
  let handle: TmpDbHandle;

  beforeEach(() => {
    handle = makeTmpDb({ agent: "openclaw" });
  });

  afterEach(() => handle.cleanup());

  it("persists enqueued work without consuming it until the worker starts", async () => {
    const execute = vi.fn(async () => undefined);
    const worker = createEvolutionWorker({
      repo: handle.repos.evolutionJobs,
      log: rootLogger.child({ channel: "test.evolution.start" }),
      now: () => NOW,
      execute,
    });

    worker.enqueue({
      jobType: "turn_enrichment",
      dedupeKey: "turn_enrichment:deferred",
      payload: { episodeId: "deferred" },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(execute).not.toHaveBeenCalled();
    expect(handle.repos.evolutionJobs.countByStatus("queued")).toBe(1);

    worker.start();
    await worker.flush();
    expect(execute).toHaveBeenCalledOnce();
    worker.stop();
  });

  it("polls SQLite so work inserted by another process is discovered", async () => {
    const secondDb = openDb({
      filepath: handle.filepath,
      agent: "hermes",
    });
    runMigrations(secondDb);
    const secondRepos = makeRepos(secondDb);
    const execute = vi.fn(async () => undefined);
    const worker = createEvolutionWorker({
      repo: handle.repos.evolutionJobs,
      log: rootLogger.child({ channel: "test.evolution.external-poll" }),
      externalPollMs: 5,
      execute,
    });

    try {
      worker.start();
      // Let the initial empty scan finish. The next insert is deliberately
      // made through another SQLite connection, so only portable polling can
      // wake this worker.
      await new Promise((resolve) => setTimeout(resolve, 20));
      secondRepos.evolutionJobs.enqueue({
        jobType: "feedback_evolution",
        dedupeKey: "feedback_evolution:external",
        payload: { feedbackId: "external" },
        now: Date.now(),
      });

      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), {
        timeout: 1_000,
        interval: 5,
      });
    } finally {
      worker.stop();
      secondDb.close();
    }
  });

  it("leaves unknown future job types queued while processing supported jobs", async () => {
    handle.db.prepare<{
      id: string;
      now: number;
    }>(
      `INSERT INTO evolution_jobs (
         id, job_type, status, dedupe_key, payload_json, attempts,
         max_attempts, available_at, claimed_by, lease_until,
         rerun_requested, last_error, created_at, updated_at
       ) VALUES (
         @id, 'future_evolution', 'queued', NULL, '{}', 0,
         3, @now, NULL, NULL, 0, NULL, @now, @now
       )`,
    ).run({ id: "ev_future", now: NOW });
    handle.repos.evolutionJobs.enqueue({
      jobType: "turn_enrichment",
      dedupeKey: "turn_enrichment:supported",
      payload: { episodeId: "supported" },
      now: NOW,
    });
    const execute = vi.fn(async () => undefined);
    const worker = createEvolutionWorker({
      repo: handle.repos.evolutionJobs,
      log: rootLogger.child({ channel: "test.evolution.compatibility" }),
      now: () => NOW,
      execute,
    });

    worker.start();
    await worker.flush();

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].jobType).toBe("turn_enrichment");
    expect(handle.db.prepare<{ id: string }, { status: string }>(
      "SELECT status FROM evolution_jobs WHERE id=@id",
    ).get({ id: "ev_future" })?.status).toBe("queued");
    worker.stop();
  });

  it("coalesces duplicate active jobs and requests one replay while leased", () => {
    const first = handle.repos.evolutionJobs.enqueue({
      jobType: "episode_evolution",
      dedupeKey: "episode_evolution:ep-1",
      payload: { episodeId: "ep-1", revision: 1 },
      now: NOW,
    });
    const duplicate = handle.repos.evolutionJobs.enqueue({
      jobType: "episode_evolution",
      dedupeKey: "episode_evolution:ep-1",
      payload: { episodeId: "ep-1", revision: 2 },
      now: NOW + 1,
    });

    expect(duplicate.id).toBe(first.id);
    expect(handle.repos.evolutionJobs.countActive()).toBe(1);
    expect(duplicate.payload).toMatchObject({ revision: 2 });

    const [leased] = handle.repos.evolutionJobs.leaseDue({
      workerId: "worker-a",
      now: NOW + 2,
      leaseUntil: NOW + 60_000,
      limit: 1,
    });
    expect(leased?.status).toBe("leased");

    handle.repos.evolutionJobs.enqueue({
      jobType: "episode_evolution",
      dedupeKey: "episode_evolution:ep-1",
      payload: { episodeId: "ep-1", revision: 3 },
      now: NOW + 3,
    });
    expect(handle.repos.evolutionJobs.completeClaimed(leased!.id, {
      workerId: "worker-a",
      leaseUntil: NOW + 60_000,
      now: NOW + 4,
    })).toBe("requeued");

    const replay = handle.repos.evolutionJobs.get(first.id)!;
    expect(replay.status).toBe("queued");
    expect(replay.rerunRequested).toBe(false);
    expect(replay.payload).toMatchObject({ revision: 3 });
  });

  it("executes semantic jobs through one global lane", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const worker = createEvolutionWorker({
      repo: handle.repos.evolutionJobs,
      log: rootLogger.child({ channel: "test.evolution.worker" }),
      now: () => NOW,
      execute: async (job) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${String(job.payload.episodeId)}`);
        if (job.payload.episodeId === "ep-1") await firstBlocked;
        order.push(`end:${String(job.payload.episodeId)}`);
        active -= 1;
      },
    });

    worker.enqueue({
      jobType: "episode_evolution",
      dedupeKey: "episode_evolution:ep-1",
      payload: { episodeId: "ep-1" },
    });
    worker.enqueue({
      jobType: "episode_evolution",
      dedupeKey: "episode_evolution:ep-2",
      payload: { episodeId: "ep-2" },
    });

    worker.start();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["start:ep-1"]);
    releaseFirst();
    await worker.flush();

    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "start:ep-1",
      "end:ep-1",
      "start:ep-2",
      "end:ep-2",
    ]);
    expect(handle.repos.evolutionJobs.countByStatus("succeeded")).toBe(2);
    worker.stop();
  });

  it("allows only one leased semantic job per database", () => {
    for (const episodeId of ["ep-1", "ep-2"]) {
      handle.repos.evolutionJobs.enqueue({
        jobType: "episode_evolution",
        dedupeKey: `episode_evolution:${episodeId}`,
        payload: { episodeId },
        now: NOW,
      });
    }

    const first = handle.repos.evolutionJobs.leaseDue({
      workerId: "worker-a",
      now: NOW,
      leaseUntil: NOW + 60_000,
      limit: 1,
    });
    const competing = handle.repos.evolutionJobs.leaseDue({
      workerId: "worker-b",
      now: NOW + 1,
      leaseUntil: NOW + 60_001,
      limit: 1,
    });

    expect(first).toHaveLength(1);
    expect(competing).toHaveLength(0);

    expect(handle.repos.evolutionJobs.renewClaimed(first[0]!.id, {
      workerId: "worker-a",
      leaseUntil: NOW + 60_000,
      nextLeaseUntil: NOW + 120_000,
      now: NOW + 30_000,
    })).toBe(true);
    expect(handle.repos.evolutionJobs.nextAvailableAt()).toBe(NOW + 120_000);
    expect(handle.repos.evolutionJobs.leaseDue({
      workerId: "worker-b",
      now: NOW + 60_001,
      leaseUntil: NOW + 180_001,
      limit: 1,
    })).toHaveLength(0);
  });

  it("recovers an interrupted lease and dead-letters terminal failures", async () => {
    handle.repos.evolutionJobs.enqueue({
      jobType: "episode_evolution",
      dedupeKey: "episode_evolution:ep-fail",
      payload: { episodeId: "ep-fail" },
      maxAttempts: 2,
      now: NOW,
    });
    handle.repos.evolutionJobs.leaseDue({
      workerId: "dead-process",
      now: NOW,
      leaseUntil: NOW + 60_000,
      limit: 1,
    });

    let clock = NOW + 60_001;
    const worker = createEvolutionWorker({
      repo: handle.repos.evolutionJobs,
      log: rootLogger.child({ channel: "test.evolution.recovery" }),
      now: () => clock,
      retryBackoffMs: () => 0,
      execute: async () => {
        throw new Error("model unavailable");
      },
    });
    worker.start();
    await worker.flush();
    clock += 1;
    await worker.flush();

    expect(handle.repos.evolutionJobs.countByStatus("dead_letter")).toBe(1);
    expect(handle.repos.evolutionJobs.list("dead_letter", 1)[0]).toMatchObject({
      attempts: 2,
      lastError: "model unavailable",
    });
    expect(handle.repos.kv.get("runtime.failure_sequence.evolution", 0)).toBe(1);
    worker.stop();
  });

  it("does not automatically delete completed queue history", async () => {
    const firstWorker = createEvolutionWorker({
      repo: handle.repos.evolutionJobs,
      log: rootLogger.child({ channel: "test.evolution.history.first" }),
      now: () => NOW,
      execute: async () => undefined,
    });
    const completed = firstWorker.enqueue({
      jobType: "turn_enrichment",
      dedupeKey: "turn_enrichment:retained-history",
      payload: { episodeId: "retained-history" },
    });
    firstWorker.start();
    await firstWorker.flush();
    firstWorker.stop();

    const laterWorker = createEvolutionWorker({
      repo: handle.repos.evolutionJobs,
      log: rootLogger.child({ channel: "test.evolution.history.later" }),
      now: () => NOW + 8 * 24 * 60 * 60_000,
      execute: async () => undefined,
    });
    laterWorker.start();
    await laterWorker.flush();

    expect(handle.repos.evolutionJobs.get(completed.id)?.status).toBe("succeeded");
    laterWorker.stop();
  });

  it("preserves a terminal turn job until an explicit retry revives it", () => {
    const input = {
      jobType: "turn_enrichment" as const,
      dedupeKey: "turn_enrichment:ep-terminal:1700000000000",
      payload: {
        episodeId: "ep-terminal",
        turnId: NOW,
        traceIds: ["tr-terminal"],
      },
      maxAttempts: 1,
      preserveTerminal: true,
      now: NOW,
    };
    const original = handle.repos.evolutionJobs.enqueue(input);
    const [leased] = handle.repos.evolutionJobs.leaseDue({
      workerId: "worker-terminal",
      now: NOW,
      leaseUntil: NOW + 60_000,
      limit: 1,
    });
    expect(handle.repos.evolutionJobs.failClaimed({
      id: leased!.id,
      workerId: "stale-worker",
      leaseUntil: NOW + 60_000,
      error: "stale failure",
      nextAttemptAt: NOW + 1,
      now: NOW + 1,
    })).toBe("stale");
    expect(handle.repos.kv.get("runtime.failure_sequence.evolution", 0)).toBe(0);
    expect(handle.repos.evolutionJobs.failClaimed({
      id: leased!.id,
      workerId: "worker-terminal",
      leaseUntil: NOW + 60_000,
      error: "permanent failure",
      nextAttemptAt: NOW + 1,
      now: NOW + 1,
    })).toBe("dead_letter");

    const recovered = handle.repos.evolutionJobs.enqueue({
      ...input,
      now: NOW + 2,
    });
    expect(recovered.id).toBe(original.id);
    expect(recovered.status).toBe("dead_letter");
    expect(handle.repos.evolutionJobs.list()).toHaveLength(1);

    expect(handle.repos.evolutionJobs.retryDeadLetter(original.id, NOW + 3))
      .toBe(true);
    expect(handle.repos.evolutionJobs.get(original.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      lastError: null,
    });
  });
});
