/**
 * `subscriber` — glue between `core/capture` and `core/reward`.
 *
 * Model:
 *   1. When `capture.done` fires for an episode with traces, register it in
 *      `pending` and schedule one reward run after `feedbackWindowSec` (≥1s).
 *   2. Explicit feedback is persisted via `memory-core.submitFeedback` (DB);
 *      the scheduled run passes `feedback: []` and `reward.run` merges from
 *      `feedbackRepo.getForEpisode`.
 *   3. When the window expires (or `drain()`), run once with
 *      `trigger="implicit_fallback"` (overridden in `reward.run` when DB has
 *      feedback rows).
 *   4. `submitFeedback` on this subscription is a no-op — do not score here.
 *
 * `pendingCount()` = scheduled-but-not-started episodes + in-flight runs.
 */

import type {
  CaptureEventBus,
} from "../capture/index.js";
import { rootLogger } from "../logger/index.js";
import type { EpisodeId } from "../types.js";
import type { RewardRunner } from "./reward.js";
import type { RewardConfig, UserFeedback } from "./types.js";

export interface RewardSubscriberOptions {
  feedbackWindowSec?: number;
  /** Called when a background run fails. Receives the original error. */
  onError?: (err: unknown, episodeId: EpisodeId) => void;
}

export interface RewardSubscription {
  /**
   * Legacy hook — no-op. Episode scoring uses DB feedback at window end;
   * use `memory-core.submitFeedback` instead.
   */
  submitFeedback(feedback: UserFeedback): void;
  /** Manual trigger — run NOW, regardless of window. */
  runManually(episodeId: EpisodeId, trigger?: "manual" | "explicit_feedback"): Promise<void>;
  /** Detach from the capture bus. In-flight runs continue. */
  stop(): void;
  /** Flush all pending episodes and wait for in-flight runs. */
  drain(): Promise<void>;
  /** Scheduled episodes (timer not fired) plus in-flight reward runs. */
  pendingCount(): number;
}

interface PendingEpisode {
  episodeId: EpisodeId;
  timer: ReturnType<typeof setTimeout> | null;
}

function resolveWindowSec(
  cfg: RewardConfig,
  opts: RewardSubscriberOptions,
): number {
  const raw = opts.feedbackWindowSec ?? cfg.feedbackWindowSec;
  return Math.max(1, raw);
}

export function attachRewardSubscriber(
  captureBus: CaptureEventBus,
  runner: RewardRunner,
  cfg: RewardConfig,
  opts: RewardSubscriberOptions = {},
): RewardSubscription {
  const log = rootLogger.child({ channel: "core.reward" });
  const windowSec = resolveWindowSec(cfg, opts);
  const windowMs = windowSec * 1_000;
  const pending = new Map<EpisodeId, PendingEpisode>();
  const inflight = new Set<Promise<unknown>>();

  function schedule(episodeId: EpisodeId, delayMs: number): void {
    const entry = pending.get(episodeId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      pending.delete(episodeId);
      runInBackground(() =>
        runner.run({
          episodeId,
          feedback: [],
          trigger: "implicit_fallback",
        }),
      );
    }, delayMs);
  }

  function runInBackground(fn: () => Promise<unknown>): void {
    const p: Promise<unknown> = fn()
      .catch((err) => {
        log.error("run.failed", { err: errDetail(err) });
        if (opts.onError) opts.onError(err, (err as { episodeId?: EpisodeId }).episodeId as EpisodeId);
      })
      .finally(() => {
        inflight.delete(p);
      });
    inflight.add(p);
  }

  const unsub = captureBus.on("capture.done", (evt) => {
    if (evt.kind !== "capture.done") return;
    const eid = evt.result.episodeId;
    if (evt.result.traceIds.length === 0) {
      log.debug("skip.empty_capture", { episodeId: eid });
      return;
    }
    pending.set(eid, { episodeId: eid, timer: null });
    schedule(eid, windowMs);
  });

  return {
    submitFeedback(feedback: UserFeedback): void {
      log.debug("submitFeedback.noop", {
        episodeId: feedback.episodeId,
        hint: "persist via memory-core.submitFeedback; score at window end",
      });
    },
    async runManually(episodeId, trigger = "manual") {
      const entry = pending.get(episodeId);
      if (entry?.timer) clearTimeout(entry.timer);
      pending.delete(episodeId);
      await runner.run({
        episodeId,
        feedback: [],
        trigger,
      });
    },
    stop() {
      for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      pending.clear();
      unsub();
    },
    async drain() {
      const flushed: PendingEpisode[] = [];
      for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        flushed.push(entry);
      }
      pending.clear();
      for (const entry of flushed) {
        runInBackground(() =>
          runner.run({
            episodeId: entry.episodeId,
            feedback: [],
            trigger: "implicit_fallback",
          }),
        );
      }
      while (inflight.size > 0) {
        await Promise.all(Array.from(inflight));
      }
    },
    pendingCount() {
      return pending.size + inflight.size;
    },
  };
}

function errDetail(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}
