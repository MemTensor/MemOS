/**
 * Unit tests for the deep-processing window queue (issue #2333).
 *
 * The gate has to satisfy two opposite safety properties:
 *
 *   - `mode: "always"` must be a complete no-op, so upgrading users see
 *     exactly the legacy behaviour (`shouldDefer()` never true).
 *   - `mode: "window"` must never lose a deferred episode silently — the
 *     queue is bounded, but every drop is logged and the dirty-reward
 *     rescan remains the backstop.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  createDeepWindowQueue,
  DEEP_PROCESSING_QUEUE_KEY,
  DEEP_PROCESSING_QUEUE_MAX,
  type DeepProcessingConfig,
  type DeepWindowKv,
} from "../../../core/pipeline/deep-window.js";
import { initTestLogger, rootLogger } from "../../../core/logger/index.js";
import type { EpisodeId } from "../../../core/types.js";

/** In-memory stand-in for the `kv` repo. */
function fakeKv(): DeepWindowKv & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get<T>(key: string, fallback: T): T {
      return raw.has(key) ? (raw.get(key) as T) : fallback;
    },
    set<T>(key: string, value: T): void {
      raw.set(key, value);
    },
  };
}

function cfg(over: Partial<DeepProcessingConfig> = {}): DeepProcessingConfig {
  return {
    mode: "window",
    window: "02:00-06:00",
    timezone: "UTC",
    drainIntervalSec: 600,
    maxBatchPerCycle: 10,
    ...over,
  };
}

/** 2026-09-05T{h}:{m}Z — the tests pin `timezone: "UTC"` so this is exact. */
function atUtc(h: number, m = 0): number {
  return Date.UTC(2026, 8, 5, h, m, 0);
}

function make(
  config: DeepProcessingConfig,
  nowMs: () => number,
  kv: DeepWindowKv = fakeKv(),
) {
  return createDeepWindowQueue({
    kv,
    config,
    log: rootLogger.child({ channel: "test.deep-window" }),
    now: nowMs,
  });
}

describe("pipeline/deep-window gate", () => {
  beforeAll(() => initTestLogger());

  it('mode "always" never defers and always reports the window open', () => {
    // Deliberately pick an instant far outside `window` to prove the mode
    // check short-circuits before the clock is consulted at all.
    const q = make(cfg({ mode: "always" }), () => atUtc(14, 30));
    expect(q.shouldDefer()).toBe(false);
    expect(q.isOpen()).toBe(true);
  });

  it('mode "window" defers outside the window and runs inside it', () => {
    let now = atUtc(14, 30);
    const q = make(cfg(), () => now);
    expect(q.shouldDefer()).toBe(true);
    expect(q.isOpen()).toBe(false);

    now = atUtc(3, 0);
    expect(q.shouldDefer()).toBe(false);
    expect(q.isOpen()).toBe(true);
  });

  it("honours the window boundaries (inclusive start, exclusive end)", () => {
    let now = atUtc(2, 0);
    const q = make(cfg(), () => now);
    expect(q.isOpen()).toBe(true);
    now = atUtc(1, 59);
    expect(q.isOpen()).toBe(false);
    now = atUtc(5, 59);
    expect(q.isOpen()).toBe(true);
    now = atUtc(6, 0);
    expect(q.isOpen()).toBe(false);
  });

  it("supports an overnight window", () => {
    let now = atUtc(23, 30);
    const q = make(cfg({ window: "23:00-07:00" }), () => now);
    expect(q.isOpen()).toBe(true);
    now = atUtc(6, 59);
    expect(q.isOpen()).toBe(true);
    now = atUtc(7, 0);
    expect(q.isOpen()).toBe(false);
  });

  it("evaluates the window in the configured timezone", () => {
    // 18:30 UTC is 02:30 the next day in Shanghai → inside 02:00-06:00.
    const q = make(
      cfg({ timezone: "Asia/Shanghai" }),
      () => atUtc(18, 30),
    );
    expect(q.isOpen()).toBe(true);
    const ny = make(
      cfg({ timezone: "America/New_York" }),
      () => atUtc(18, 30),
    );
    expect(ny.isOpen()).toBe(false);
  });

  it('never defers when the mode is "always" even with a broken window spec', () => {
    // `resolveConfig` rejects this in `mode: "window"`; in `"always"` the
    // spec is irrelevant and must not accidentally enable deferral.
    const q = make(cfg({ mode: "always", window: "nonsense" }), () => atUtc(3));
    expect(q.shouldDefer()).toBe(false);
  });
});

describe("pipeline/deep-window queue", () => {
  beforeAll(() => initTestLogger());

  it("enqueues entries and reports depth", () => {
    const kv = fakeKv();
    const q = make(cfg(), () => atUtc(14), kv);
    q.enqueue("ep_1" as EpisodeId, "finalized");
    q.enqueue("ep_2" as EpisodeId, "abandoned");
    expect(q.size()).toBe(2);
    expect(kv.raw.get(DEEP_PROCESSING_QUEUE_KEY)).toEqual([
      { episodeId: "ep_1", closedBy: "finalized", queuedAt: atUtc(14) },
      { episodeId: "ep_2", closedBy: "abandoned", queuedAt: atUtc(14) },
    ]);
  });

  it("deduplicates by episode id", () => {
    const q = make(cfg(), () => atUtc(14));
    q.enqueue("ep_1" as EpisodeId, "finalized");
    q.enqueue("ep_1" as EpisodeId, "finalized");
    q.enqueue("ep_1" as EpisodeId, "abandoned");
    expect(q.size()).toBe(1);
  });

  it("takeBatch drains oldest-first up to maxBatchPerCycle and removes them", () => {
    const kv = fakeKv();
    let now = atUtc(14);
    const q = make(cfg({ maxBatchPerCycle: 2 }), () => now, kv);
    q.enqueue("ep_old" as EpisodeId, "finalized");
    now += 1_000;
    q.enqueue("ep_mid" as EpisodeId, "finalized");
    now += 1_000;
    q.enqueue("ep_new" as EpisodeId, "finalized");

    const first = q.takeBatch();
    expect(first.map((e) => e.episodeId)).toEqual(["ep_old", "ep_mid"]);
    expect(q.size()).toBe(1);

    const second = q.takeBatch();
    expect(second.map((e) => e.episodeId)).toEqual(["ep_new"]);
    expect(q.size()).toBe(0);
    expect(q.takeBatch()).toEqual([]);
  });

  it("caps the queue so kv cannot grow without bound", () => {
    const q = make(cfg(), () => atUtc(14));
    for (let i = 0; i < DEEP_PROCESSING_QUEUE_MAX + 5; i++) {
      q.enqueue(`ep_${i}` as EpisodeId, "finalized");
    }
    expect(q.size()).toBe(DEEP_PROCESSING_QUEUE_MAX);
  });

  it("ignores a corrupt kv payload instead of throwing", () => {
    const kv = fakeKv();
    kv.set(DEEP_PROCESSING_QUEUE_KEY, { not: "an array" });
    const q = make(cfg(), () => atUtc(14), kv);
    expect(q.size()).toBe(0);
    q.enqueue("ep_1" as EpisodeId, "finalized");
    expect(q.size()).toBe(1);
  });

  it("drops malformed entries but keeps the well-formed ones", () => {
    const kv = fakeKv();
    kv.set(DEEP_PROCESSING_QUEUE_KEY, [
      { episodeId: "ep_ok", closedBy: "finalized", queuedAt: 1 },
      { episodeId: "ep_bad_reason", closedBy: "exploded", queuedAt: 2 },
      { episodeId: 42, closedBy: "finalized", queuedAt: 3 },
      null,
    ]);
    const q = make(cfg(), () => atUtc(14), kv);
    expect(q.size()).toBe(1);
    expect(q.takeBatch().map((e) => e.episodeId)).toEqual(["ep_ok"]);
  });
});
