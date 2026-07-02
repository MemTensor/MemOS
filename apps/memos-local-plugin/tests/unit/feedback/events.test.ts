import { describe, it, expect, vi } from "vitest";

import { createFeedbackEventBus } from "../../../core/feedback/events.js";
import type { EpochMs } from "../../../core/types.js";

describe("feedback/events", () => {
  it("delivers events to targeted and any listeners", () => {
    const bus = createFeedbackEventBus();
    const targeted = vi.fn();
    const any = vi.fn();
    bus.on("repair.triggered", targeted);
    bus.onAny(any);

    bus.emit({
      kind: "repair.triggered",
      at: 0 as EpochMs,
      contextHash: "c1",
      trigger: "manual",
    });

    expect(targeted).toHaveBeenCalledTimes(1);
    expect(any).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount("repair.triggered")).toBe(2);
    expect(bus.listenerCount()).toBe(2);
  });

  it("unsubscribe via the returned function", () => {
    const bus = createFeedbackEventBus();
    const spy = vi.fn();
    const off = bus.on("repair.persisted", spy);
    bus.emit({
      kind: "repair.persisted",
      at: 0 as EpochMs,
      contextHash: "c",
      repairId: "r",
      confidence: 0.5,
      severity: "info",
    });
    off();
    bus.emit({
      kind: "repair.persisted",
      at: 0 as EpochMs,
      contextHash: "c",
      repairId: "r",
      confidence: 0.5,
      severity: "info",
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("isolates listener errors so one bad handler doesn't break the rest", () => {
    const bus = createFeedbackEventBus();
    const good = vi.fn();
    bus.on("repair.skipped", () => {
      throw new Error("bad listener");
    });
    bus.on("repair.skipped", good);

    bus.emit({
      kind: "repair.skipped",
      at: 0 as EpochMs,
      contextHash: "c",
      trigger: "user.negative",
      reason: "cooldown",
    });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("dispatches classified feedback events without extra metadata", () => {
    const bus = createFeedbackEventBus();
    const spy = vi.fn();
    bus.on("feedback.classified", spy);
    bus.emit({
      kind: "feedback.classified",
      at: 0 as EpochMs,
      shape: "preference",
      confidence: 0.8,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("listenerCount reports totals with kind omitted", () => {
    const bus = createFeedbackEventBus();
    const off1 = bus.on("repair.triggered", () => {});
    bus.on("repair.persisted", () => {});
    bus.onAny(() => {});
    expect(bus.listenerCount()).toBe(3);
    off1();
    expect(bus.listenerCount()).toBe(2);
  });
});
