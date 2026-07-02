import { describe, expect, it } from "vitest";

import { createCaptureEventBus } from "../../../core/capture/events.js";
import type { CaptureEvent } from "../../../core/capture/types.js";

function makeStartEvent(): CaptureEvent {
  return {
    kind: "capture.started",
    episodeId: "ep_1" as unknown as CaptureEvent extends { episodeId: infer E } ? E : never,
    sessionId: "se_1" as unknown as CaptureEvent extends { sessionId: infer S } ? S : never,
  } as CaptureEvent;
}

describe("capture/events bus", () => {
  it("delivers to targeted listener only", () => {
    const bus = createCaptureEventBus();
    const seenStart: CaptureEvent[] = [];
    const seenDone: CaptureEvent[] = [];
    bus.on("capture.started", (e) => seenStart.push(e));
    bus.on("capture.done", (e) => seenDone.push(e));
    bus.emit(makeStartEvent());
    expect(seenStart).toHaveLength(1);
    expect(seenDone).toHaveLength(0);
  });

  it("delivers to onAny listener for any kind", () => {
    const bus = createCaptureEventBus();
    const seen: CaptureEvent[] = [];
    bus.onAny((e) => seen.push(e));
    bus.emit(makeStartEvent());
    expect(seen).toHaveLength(1);
  });

  it("unsubscribes cleanly", () => {
    const bus = createCaptureEventBus();
    const seen: CaptureEvent[] = [];
    const off = bus.on("capture.started", (e) => seen.push(e));
    off();
    bus.emit(makeStartEvent());
    expect(seen).toHaveLength(0);
  });

  it("listener throw does not break other listeners", () => {
    const bus = createCaptureEventBus();
    let reached = false;
    bus.on("capture.started", () => {
      throw new Error("boom");
    });
    bus.on("capture.started", () => {
      reached = true;
    });
    bus.emit(makeStartEvent());
    expect(reached).toBe(true);
  });

  it("listenerCount tracks per-kind + any", () => {
    const bus = createCaptureEventBus();
    expect(bus.listenerCount()).toBe(0);
    const off1 = bus.on("capture.started", () => {});
    const off2 = bus.onAny(() => {});
    expect(bus.listenerCount()).toBe(2);
    expect(bus.listenerCount("capture.started")).toBe(2);
    expect(bus.listenerCount("capture.done")).toBe(1);
    off1();
    off2();
    expect(bus.listenerCount()).toBe(0);
  });
});
