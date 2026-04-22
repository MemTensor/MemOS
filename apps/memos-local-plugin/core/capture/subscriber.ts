/**
 * `subscriber` — wire the capture runner into the Phase 5 session bus.
 *
 * One call wires up `session.episode.finalized` → `runner.run(...)`. The
 * orchestrator (Phase 15) will replace this with a richer subscriber that
 * chains reward / l2.incremental / skill crystallization, but this module
 * is standalone: you can plug it into the `SessionManager` today and it
 * will happily write L1 rows with α scores.
 */

import { rootLogger } from "../logger/index.js";
import type { SessionEventBus } from "../session/types.js";
import type { CaptureRunner } from "./capture.js";

export interface CaptureSubscriberOptions {
  /**
   * When true, also run capture on `closedBy: "abandoned"` episodes.
   * Default true — the V7 spec says abandoned episodes should land in the
   * trace log with R_task = −1 so they contribute to anti-patterns.
   */
  captureAbandoned?: boolean;
  /** Callback for unhandled errors from fire-and-forget captures. */
  onError?: (err: unknown) => void;
}

export interface CaptureSubscription {
  /** Unsubscribe from the bus. Outstanding captures continue running. */
  stop(): void;
  /** Wait for every in-flight capture to finish. Test-only; safe to `await`. */
  drain(): Promise<void>;
  /** Count of currently-running captures — useful for assertions. */
  pendingCount(): number;
}

export function attachCaptureSubscriber(
  bus: SessionEventBus,
  runner: CaptureRunner,
  opts: CaptureSubscriberOptions = {},
): CaptureSubscription {
  const log = rootLogger.child({ channel: "core.capture" });
  const captureAbandoned = opts.captureAbandoned ?? true;
  const pending = new Set<Promise<unknown>>();

  const unsub = bus.on("episode.finalized", (evt) => {
    if (evt.kind !== "episode.finalized") return;
    if (evt.closedBy === "abandoned" && !captureAbandoned) {
      log.debug("subscriber.skip_abandoned", { episodeId: evt.episode.id });
      return;
    }
    // Topic ended → batch reflect across every step + emit
    // `capture.done` so the reward subscriber kicks off R_human + V
    // backprop. Per-turn lite captures already wrote the trace rows;
    // this pass just patches reflection + α onto them.
    const p: Promise<unknown> = runner
      .runReflect({ episode: evt.episode, closedBy: evt.closedBy })
      .catch((err) => {
        log.error("subscriber.capture_failed", {
          episodeId: evt.episode.id,
          err: errDetail(err),
        });
        if (opts.onError) opts.onError(err);
      })
      .finally(() => {
        pending.delete(p);
      });
    pending.add(p);
  });

  return {
    stop() {
      unsub();
    },
    async drain() {
      while (pending.size > 0) {
        await Promise.all(Array.from(pending));
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
}

function errDetail(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}
