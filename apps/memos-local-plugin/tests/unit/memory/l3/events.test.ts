/**
 * Unit tests for `createL3EventBus`.
 * Mirrors the L2 bus contract — targeted + wildcard listeners, quiet swallow
 * of listener errors, accurate listenerCount.
 */

import { describe, expect, it } from "vitest";

import { createL3EventBus } from "../../../../core/memory/l3/events.js";
import type {
  L3Event,
  L3EventKind,
} from "../../../../core/memory/l3/types.js";

function createEvent(kind: L3EventKind): L3Event {
  if (kind === "l3.abstraction.started")
    return { kind: "l3.abstraction.started", trigger: "manual", clusterCount: 0 };
  if (kind === "l3.world-model.created")
    return {
      kind: "l3.world-model.created",
      worldModelId: "wm_1" as L3Event & { worldModelId: string } extends never ? never : any,
      title: "t",
      domainTags: [],
      policyIds: [],
      confidence: 0.5,
    } as L3Event;
  if (kind === "l3.world-model.updated")
    return {
      kind: "l3.world-model.updated",
      worldModelId: "wm_1" as any,
      title: "t",
      domainTags: [],
      policyIds: [],
      confidence: 0.5,
    } as L3Event;
  if (kind === "l3.confidence.adjusted")
    return {
      kind: "l3.confidence.adjusted",
      worldModelId: "wm_1" as any,
      previous: 0.5,
      next: 0.7,
      reason: "test",
    } as L3Event;
  return { kind: "l3.failed", stage: "run", error: { code: "X", message: "y" } };
}

describe("memory/l3/events", () => {
  it("delivers targeted + wildcard listeners once each", () => {
    const bus = createL3EventBus();
    const targeted: L3Event[] = [];
    const any: L3Event[] = [];
    bus.on("l3.abstraction.started", (e) => targeted.push(e));
    bus.onAny((e) => any.push(e));

    bus.emit(createEvent("l3.abstraction.started"));
    bus.emit(createEvent("l3.failed"));

    expect(targeted.length).toBe(1);
    expect(any.length).toBe(2);
  });

  it("off() stops delivery without affecting siblings", () => {
    const bus = createL3EventBus();
    const target: L3Event[] = [];
    const other: L3Event[] = [];
    const stop = bus.on("l3.abstraction.started", (e) => target.push(e));
    bus.on("l3.abstraction.started", (e) => other.push(e));

    stop();
    bus.emit(createEvent("l3.abstraction.started"));

    expect(target.length).toBe(0);
    expect(other.length).toBe(1);
  });

  it("listenerCount reports per-kind + total correctly", () => {
    const bus = createL3EventBus();
    expect(bus.listenerCount()).toBe(0);
    bus.on("l3.abstraction.started", () => {});
    bus.onAny(() => {});
    expect(bus.listenerCount("l3.abstraction.started")).toBe(2); // targeted + any
    expect(bus.listenerCount("l3.failed")).toBe(1);               // any only
    expect(bus.listenerCount()).toBe(2);                          // 1 targeted + 1 any
  });

  it("swallows listener errors without breaking siblings", () => {
    const bus = createL3EventBus();
    const after: L3Event[] = [];
    bus.on("l3.abstraction.started", () => {
      throw new Error("boom");
    });
    bus.on("l3.abstraction.started", (e) => after.push(e));

    bus.emit(createEvent("l3.abstraction.started"));
    expect(after.length).toBe(1);
  });
});
