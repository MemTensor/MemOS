import { describe, expect, it, vi } from "vitest";

import { createRewardEventBus } from "../../../core/reward/events.js";
import type { RewardEvent } from "../../../core/reward/types.js";

const dummyEvt = {
  kind: "reward.scheduled",
  episodeId: "ep_1",
  sessionId: "s_1",
} as unknown as RewardEvent;

describe("reward/events", () => {
  it("delivers targeted and any listeners", () => {
    const bus = createRewardEventBus();
    const targeted = vi.fn();
    const any = vi.fn();

    bus.on("reward.scheduled", targeted);
    bus.onAny(any);

    bus.emit(dummyEvt);
    expect(targeted).toHaveBeenCalledTimes(1);
    expect(any).toHaveBeenCalledTimes(1);

    bus.emit({ ...dummyEvt, kind: "reward.scored", rHuman: 0.5, source: "heuristic" } as unknown as RewardEvent);
    expect(targeted).toHaveBeenCalledTimes(1);
    expect(any).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes cleanly", () => {
    const bus = createRewardEventBus();
    const fn = vi.fn();
    const off = bus.on("reward.scheduled", fn);
    bus.emit(dummyEvt);
    off();
    bus.emit(dummyEvt);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("isolates listener errors from each other", () => {
    const bus = createRewardEventBus();
    const bad = vi.fn(() => {
      throw new Error("explode");
    });
    const good = vi.fn();

    bus.on("reward.scheduled", bad);
    bus.on("reward.scheduled", good);
    expect(() => bus.emit(dummyEvt)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("listenerCount tracks both targeted and any lists", () => {
    const bus = createRewardEventBus();
    expect(bus.listenerCount()).toBe(0);
    const off1 = bus.on("reward.scheduled", () => {});
    bus.onAny(() => {});
    expect(bus.listenerCount()).toBe(2);
    expect(bus.listenerCount("reward.scheduled")).toBe(2); // targeted + any
    off1();
    expect(bus.listenerCount("reward.scheduled")).toBe(1);
  });
});
