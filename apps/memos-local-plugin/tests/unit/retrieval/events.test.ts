import { describe, expect, it } from "vitest";

import { createRetrievalEventBus, type RetrievalEvent } from "../../../core/retrieval/events.js";

const baseEvt: RetrievalEvent = {
  kind: "retrieval.started",
  reason: "turn_start",
  agent: "openclaw",
  sessionId: "s1" as never,
  queryTags: ["docker"],
  ts: 1_700_000_000_000 as never,
};

describe("retrieval/events", () => {
  it("delivers to generic + kind listeners", () => {
    const bus = createRetrievalEventBus();
    const seen: string[] = [];
    bus.on((e) => seen.push(`all:${e.kind}`));
    bus.onKind("retrieval.started", (e) => seen.push(`started:${e.queryTags.join(",")}`));
    bus.onKind("retrieval.done", () => seen.push("done!"));

    bus.emit(baseEvt);
    expect(seen).toEqual(["all:retrieval.started", "started:docker"]);
  });

  it("unsubscribe cancels a listener", () => {
    const bus = createRetrievalEventBus();
    const seen: string[] = [];
    const off = bus.on((e) => seen.push(e.kind));
    bus.emit(baseEvt);
    off();
    bus.emit(baseEvt);
    expect(seen).toEqual(["retrieval.started"]);
  });

  it("isolates listener errors", () => {
    const bus = createRetrievalEventBus();
    bus.on(() => {
      throw new Error("bad listener");
    });
    const seen: string[] = [];
    bus.on((e) => seen.push(e.kind));
    expect(() => bus.emit(baseEvt)).not.toThrow();
    expect(seen).toEqual(["retrieval.started"]);
  });
});
