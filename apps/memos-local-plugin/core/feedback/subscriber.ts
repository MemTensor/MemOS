/**
 * Wires the feedback module to its upstream signals.
 *
 * The feedback subscriber exposes **two** imperative channels that
 * adapters drive directly — there is no background event bus for
 * failure counting because the signals must be live inside the agent
 * step loop:
 *
 *   - `recordToolFailure` / `recordToolSuccess` — forwarded to the
 *     `failureSignals` tracker. When a burst is detected the subscriber
 *     schedules a `runRepair` on a microtask so adapters never block.
 *
 *   - `submitUserFeedback` — fires a repair run with the classified
 *     feedback. Also emits `feedback.classified` for downstream UI.
 *
 * The handle also exposes `runOnce` for manual triggers (viewer button)
 * and `dispose` for cleanup.
 */

import type { Logger } from "../logger/types.js";
import { rootLogger } from "../logger/index.js";
import type { EpisodeId, EpochMs, SessionId } from "../types.js";
import {
  contextHashOf,
  createFailureSignals,
  type FailureSignalsHandle,
} from "./signals.js";
import { runRepair, type RepairDeps } from "./feedback.js";
import type {
  FailureBurst,
  FailureRecord,
  FeedbackConfig,
  RepairInput,
  RepairResult,
} from "./types.js";

export interface FeedbackSubscriberDeps extends Omit<RepairDeps, "log"> {
  log?: Logger;
}

export interface RecordToolCallInput {
  toolId: string;
  context: string;
  step: number;
  reason?: string;
  sessionId?: SessionId;
  episodeId?: EpisodeId;
}

export interface SubmitUserFeedbackInput {
  text: string;
  sessionId: SessionId;
  episodeId?: EpisodeId;
  toolId?: string;
  context?: string;
}

export interface FeedbackSubscriberHandle {
  recordToolFailure(input: RecordToolCallInput): void;
  recordToolSuccess(input: Omit<RecordToolCallInput, "reason">): void;
  submitUserFeedback(input: SubmitUserFeedbackInput): Promise<RepairResult>;
  runOnce(input: RepairInput): Promise<RepairResult>;
  signals: FailureSignalsHandle;
  flush(): Promise<void>;
  dispose(): void;
}

export function attachFeedbackSubscriber(
  deps: FeedbackSubscriberDeps,
): FeedbackSubscriberHandle {
  const log =
    deps.log ?? rootLogger.child({ channel: "core.feedback.subscriber" });
  const runDeps: RepairDeps = { ...deps, log };
  const signals = createFailureSignals({
    config: deps.config,
    log: log.child({ channel: "core.feedback.signals" }),
  });

  let inflight: Promise<void> | null = null;
  const queue: Array<() => Promise<void>> = [];

  function enqueue(job: () => Promise<void>): void {
    queue.push(job);
    if (inflight) return;
    const promise = drain().finally(() => {
      if (inflight === promise) inflight = null;
    });
    inflight = promise;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      try {
        await job();
      } catch (err) {
        log.error("repair.job.failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  function triggerFromBurst(burst: FailureBurst): void {
    const input: RepairInput = {
      trigger: "failure-burst",
      contextHash: burst.contextHash,
      toolId: burst.toolId,
      failures: burst.occurrences,
      sessionId: burst.occurrences.find((o) => o.sessionId)?.sessionId,
      episodeId: burst.occurrences.find((o) => o.episodeId)?.episodeId,
    };
    enqueue(async () => {
      await runRepair(input, runDeps);
      signals.clear(burst.contextHash);
    });
  }

  return {
    signals,

    recordToolFailure(input: RecordToolCallInput): void {
      const now = Date.now() as EpochMs;
      const record: FailureRecord = {
        toolId: input.toolId,
        context: input.context,
        step: input.step,
        reason: input.reason ?? "",
        ts: now,
        sessionId: input.sessionId,
        episodeId: input.episodeId,
      };
      const burst = signals.recordFailure(record);
      if (burst) {
        log.info("failure.burst.detected", {
          toolId: burst.toolId,
          context: burst.context,
          count: burst.failureCount,
        });
        triggerFromBurst(burst);
      }
    },

    recordToolSuccess(input): void {
      signals.recordSuccess(input.toolId, input.context, input.step);
    },

    async submitUserFeedback(
      input: SubmitUserFeedbackInput,
    ): Promise<RepairResult> {
      const ctx = input.context ?? input.sessionId ?? "_";
      const tool = input.toolId ?? "_";
      const contextHash = contextHashOf(tool, ctx);
      const repairInput: RepairInput = {
        trigger: "user.negative",
        contextHash,
        toolId: input.toolId,
        userText: input.text,
        sessionId: input.sessionId,
        episodeId: input.episodeId,
      };
      return runRepair(repairInput, runDeps);
    },

    async runOnce(input: RepairInput): Promise<RepairResult> {
      return runRepair(input, runDeps);
    },

    async flush(): Promise<void> {
      while (inflight) {
        await inflight;
      }
    },

    dispose(): void {
      signals.clear();
      log.info("feedback.subscriber.disposed");
    },
  };
}
