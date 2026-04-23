import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createSessionEventBus } from "../../../core/session/events.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type { SessionEvent } from "../../../core/session/types.js";

describe("session/events", () => {
  beforeAll(() => initTestLogger());
  afterEach(() => {
    // nothing — each test builds its own bus
  });

  function mkEvent(): SessionEvent {
    return { kind: "session.closed", sessionId: "se_fake", reason: "test" };
  }

  it("on(kind) delivers typed events and returns an unsubscribe", () => {
    const bus = createSessionEventBus();
    const seen: SessionEvent[] = [];
    const off = bus.on("session.closed", (e) => seen.push(e));
    bus.emit(mkEvent());
    expect(seen).toHaveLength(1);
    off();
    bus.emit(mkEvent());
    expect(seen).toHaveLength(1); // not delivered after unsubscribe
  });

  it("onAny receives every event kind", () => {
    const bus = createSessionEventBus();
    const seen: SessionEvent[] = [];
    bus.onAny((e) => seen.push(e));
    bus.emit(mkEvent());
    bus.emit({ kind: "session.idle_pruned", sessionId: "se_x", idleMs: 1_000 });
    expect(seen.map((e) => e.kind)).toEqual(["session.closed", "session.idle_pruned"]);
  });

  it("listener error does not break sibling listeners", () => {
    const bus = createSessionEventBus();
    const seen: string[] = [];
    bus.on("session.closed", () => {
      throw new Error("boom");
    });
    bus.on("session.closed", () => seen.push("sibling-ran"));
    bus.emit(mkEvent());
    expect(seen).toEqual(["sibling-ran"]);
  });

  it("listenerCount aggregates targeted + any subscribers", () => {
    const bus = createSessionEventBus();
    expect(bus.listenerCount()).toBe(0);
    bus.on("session.closed", () => {});
    bus.onAny(() => {});
    expect(bus.listenerCount("session.closed")).toBe(2);
    expect(bus.listenerCount("session.started")).toBe(1); // only the onAny
    expect(bus.listenerCount()).toBe(2);
  });

  it("emit delivers targeted listeners before anyListeners", () => {
    const bus = createSessionEventBus();
    const order: string[] = [];
    bus.on("session.closed", () => order.push("targeted"));
    bus.onAny(() => order.push("any"));
    bus.emit(mkEvent());
    expect(order).toEqual(["targeted", "any"]);
  });
});
