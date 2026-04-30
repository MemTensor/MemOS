import type { CoreEvent } from "../../agent-contract/events.js";
import { ids } from "../id.js";
import type { Embedder } from "./types.js";
import type { Logger } from "../logger/types.js";
import type { Repos } from "../storage/repos/index.js";
import type { EmbeddingRetryClaim, EmbeddingRetryJob } from "../storage/repos/embedding_retry_queue.js";
import type { EmbeddingVector } from "../types.js";

export interface EmbeddingRetryWorker {
  start(): void;
  stop(): void;
  flush(): Promise<void>;
}

export interface EmbeddingRetryWorkerDeps {
  repos: Repos;
  embedder: Embedder | null;
  log: Logger;
  now?: () => number;
  intervalMs?: number;
  batchSize?: number;
  onSystemError?: (payload: Record<string, unknown>, correlationId?: string) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const DEFAULT_LEASE_MS = 5 * 60_000;

export function createEmbeddingRetryWorker(
  deps: EmbeddingRetryWorkerDeps,
): EmbeddingRetryWorker {
  const now = deps.now ?? Date.now;
  const batchSize = deps.batchSize ?? 25;
  const workerId = `embedding-retry-${ids.span()}`;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;

  async function runOnce(): Promise<void> {
    if (!deps.embedder) return;
    const at = now();
    const jobs = deps.repos.embeddingRetryQueue.claimDue({
      now: at,
      workerId,
      leaseUntil: at + DEFAULT_LEASE_MS,
      limit: batchSize,
    });
    for (const job of jobs) {
      await processJob(job);
    }
  }

  async function processJob(job: EmbeddingRetryJob): Promise<void> {
    if (!deps.embedder) return;
    const claim = claimFor(job);
    if (!claim) {
      deps.log.debug("embedding_retry.stale_missing_claim", { jobId: job.id });
      return;
    }
    const attemptNo = job.attempts + 1;
    try {
      const vec = await deps.embedder.embedOne({
        text: job.sourceText || "(empty)",
        role: job.embedRole,
      });
      const completed = deps.repos.embeddingRetryQueue.transact(() => {
        const at = now();
        if (!deps.repos.embeddingRetryQueue.touchClaimHeld(job.id, { ...claim, now: at })) {
          return { stale: true, updated: false, completed: false };
        }
        const updated = applyVector(job, vec);
        if (!updated) {
          return { stale: false, updated: false, completed: false };
        }
        return {
          stale: false,
          updated: true,
          completed: deps.repos.embeddingRetryQueue.markSucceededClaimed(job.id, {
            ...claim,
            now: at,
          }),
        };
      });
      if (completed.stale) {
        deps.log.debug("embedding_retry.stale_success_ignored", { jobId: job.id });
        return;
      }
      if (!completed.updated) {
        throw new Error(`embedding retry target not found: ${job.targetKind}:${job.targetId}`);
      }
      if (!completed.completed) {
        deps.log.debug("embedding_retry.stale_success_ignored", { jobId: job.id });
        return;
      }
      deps.log.info("embedding_retry.succeeded", {
        jobId: job.id,
        targetKind: job.targetKind,
        targetId: job.targetId,
        vectorField: job.vectorField,
        attempts: attemptNo,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const at = now();
      const terminal = attemptNo >= job.maxAttempts;
      const recorded = terminal
        ? deps.repos.embeddingRetryQueue.markFailedClaimed(job.id, {
          ...claim,
          attempts: attemptNo,
          error: message,
          now: at,
        })
        : deps.repos.embeddingRetryQueue.markRetryClaimed(job.id, {
          ...claim,
          attempts: attemptNo,
          nextAttemptAt: at + backoffMs(attemptNo),
          error: message,
          now: at,
        });
      if (!recorded) {
        deps.log.debug("embedding_retry.stale_failure_ignored", { jobId: job.id, terminal });
        return;
      }
      emitFailure(job, attemptNo, message, terminal, at);
    }
  }

  function claimFor(job: EmbeddingRetryJob): EmbeddingRetryClaim | null {
    if (job.claimedBy !== workerId || job.leaseUntil === null) return null;
    return { workerId, leaseUntil: job.leaseUntil };
  }

  function applyVector(job: EmbeddingRetryJob, vec: EmbeddingVector): boolean {
    switch (job.targetKind) {
      case "trace":
        return deps.repos.traces.updateVector(
          job.targetId as never,
          job.vectorField === "vec_action" ? "vecAction" : "vecSummary",
          vec,
        );
      case "policy":
        return deps.repos.policies.updateVector(job.targetId as never, vec);
      case "world_model":
        return deps.repos.worldModel.updateVector(job.targetId as never, vec);
      case "skill":
        return deps.repos.skills.updateVector(job.targetId as never, vec);
    }
  }

  function emitFailure(
    job: EmbeddingRetryJob,
    attempts: number,
    message: string,
    terminal: boolean,
    at: number,
  ): void {
    const payload = {
      kind: "embedding.retry_failed",
      jobId: job.id,
      targetKind: job.targetKind,
      targetId: job.targetId,
      vectorField: job.vectorField,
      attempts,
      maxAttempts: job.maxAttempts,
      terminal,
      message,
    };
    deps.log.warn("embedding_retry.failed", payload);
    try {
      deps.repos.apiLogs.insert({
        toolName: "system_error",
        input: { role: "embedding_retry" },
        output: payload,
        durationMs: 0,
        success: false,
        calledAt: at,
      });
    } catch {
      /* logging the retry failure is best-effort */
    }
    deps.onSystemError?.(payload, job.targetId);
  }

  function tick(): void {
    if (running) return;
    running = runOnce().finally(() => {
      running = null;
    });
  }

  return {
    start(): void {
      if (timer || !deps.embedder) return;
      tick();
      timer = setInterval(tick, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    async flush(): Promise<void> {
      tick();
      if (running) await running;
    },
  };
}

function backoffMs(attemptNo: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attemptNo - 1));
}

export function systemErrorEvent(
  payload: Record<string, unknown>,
  seq: number,
  correlationId?: string,
): CoreEvent {
  return {
    type: "system.error",
    ts: Date.now(),
    seq,
    correlationId,
    payload,
  };
}
