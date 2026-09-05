/**
 * Deep-processing window queue (issue #2333).
 *
 * When `algorithm.deepProcessing.mode` is `"window"`, episodes that close
 * outside the configured idle window are captured and stored normally but
 * their evolution chain (reflect → reward → L2 → L3 → skill) is queued
 * here instead of running immediately. The drain re-emits
 * `episode.finalized` inside the window so the normal subscriber chain
 * does the work when the user's provider quota is idle.
 *
 * The queue is a fast path, not a system of record: the dirty-reward
 * rescan in `memory-core.ts` finds the same episodes by predicate (closed
 * + traces + no `rTask`), so a dropped or lost entry only delays the work,
 * it never loses it. That is why enqueue failures are logged and swallowed
 * rather than propagated.
 */

import type { EpisodeId } from "../types.js";
import type { EpisodeCloseReason } from "../session/types.js";
import type { Logger } from "../logger/types.js";
import {
  isWithinDailyWindow,
  parseDailyWindow,
  type DailyWindow,
} from "../util/time-window.js";

export const DEEP_PROCESSING_QUEUE_KEY = "pipeline.deep_processing_queue.v1";

/**
 * Hard cap on queued entries. Past this the enqueue is dropped and the
 * dirty-reward rescan becomes the only path for those episodes — bounded
 * memory beats an unbounded JSON blob in `kv`.
 */
export const DEEP_PROCESSING_QUEUE_MAX = 1_000;

export interface DeepProcessingConfig {
  mode: "always" | "window";
  window: string;
  timezone: string;
  drainIntervalSec: number;
  maxBatchPerCycle: number;
}

export interface DeepWindowQueueEntry {
  episodeId: EpisodeId;
  closedBy: EpisodeCloseReason;
  queuedAt: number;
}

/** The `kv` slice this module needs. Structural so tests can fake it. */
export interface DeepWindowKv {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
}

export interface DeepWindowQueue {
  /** False when `mode: "always"`, or when the wall clock is in the window. */
  shouldDefer(): boolean;
  /** True when heavy evolution work is allowed to run right now. */
  isOpen(): boolean;
  /** Persist an episode for later batch processing. Deduplicates by id. */
  enqueue(episodeId: EpisodeId, closedBy: EpisodeCloseReason): void;
  /** Remove and return up to `maxBatchPerCycle` entries, oldest first. */
  takeBatch(): DeepWindowQueueEntry[];
  /** Current queue depth. */
  size(): number;
}

export interface DeepWindowQueueDeps {
  kv: DeepWindowKv;
  config: DeepProcessingConfig;
  log: Logger;
  now?: () => number;
}

export function createDeepWindowQueue(deps: DeepWindowQueueDeps): DeepWindowQueue {
  const now = deps.now ?? Date.now;
  const enabled = deps.config.mode === "window";
  // Parsed once: `resolveConfig` rejects a malformed spec at load time, so
  // a null here means a caller built the config by hand. Treat it as "no
  // window" — `isOpen()` then stays false and nothing is deferred either,
  // because `shouldDefer()` short-circuits on `enabled`.
  const window: DailyWindow | null = enabled
    ? parseDailyWindow(deps.config.window)
    : null;
  const maxBatch = Math.max(1, Math.floor(deps.config.maxBatchPerCycle));

  function read(): DeepWindowQueueEntry[] {
    const raw = deps.kv.get<unknown>(DEEP_PROCESSING_QUEUE_KEY, null);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isQueueEntry);
  }

  function isOpen(): boolean {
    if (!enabled) return true;
    return isWithinDailyWindow(now(), window, deps.config.timezone);
  }

  return {
    isOpen,

    shouldDefer(): boolean {
      if (!enabled) return false;
      return !isOpen();
    },

    enqueue(episodeId, closedBy): void {
      const entries = read();
      if (entries.some((e) => e.episodeId === episodeId)) return;
      if (entries.length >= DEEP_PROCESSING_QUEUE_MAX) {
        deps.log.warn("deep_window.queue_full", {
          episodeId,
          size: entries.length,
          max: DEEP_PROCESSING_QUEUE_MAX,
        });
        return;
      }
      entries.push({ episodeId, closedBy, queuedAt: now() });
      deps.kv.set(DEEP_PROCESSING_QUEUE_KEY, entries);
    },

    takeBatch(): DeepWindowQueueEntry[] {
      const entries = read();
      if (entries.length === 0) return [];
      entries.sort((a, b) => a.queuedAt - b.queuedAt);
      const batch = entries.slice(0, maxBatch);
      deps.kv.set(DEEP_PROCESSING_QUEUE_KEY, entries.slice(batch.length));
      return batch;
    },

    size(): number {
      return read().length;
    },
  };
}

function isQueueEntry(value: unknown): value is DeepWindowQueueEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<DeepWindowQueueEntry>;
  return (
    typeof e.episodeId === "string" &&
    (e.closedBy === "finalized" || e.closedBy === "abandoned") &&
    typeof e.queuedAt === "number"
  );
}
