/**
 * Tiny test for `createL2EventBus`: listener ordering + detach behaviour.
 */

import { describe, expect, it } from "vitest";

import { createL2EventBus } from "../../../../core/memory/l2/events.js";
import type { L2Event } from "../../../../core/memory/l2/types.js";

describe("memory/l2/events", () => {
  it("delivers to typed listeners and wildcard listeners", () => {
    const bus = createL2EventBus();
    const a: L2Event[] = [];
    const any: L2Event[] = [];
    const off1 = bus.on("l2.candidate.added", (e) => a.push(e));
    const off2 = bus.onAny((e) => any.push(e));

    const evt: L2Event = {
      kind: "l2.candidate.added",
      episodeId: "ep_1" as L2Event["episodeId"],
      traceId: "tr_1" as any,
      signature: "x|y|z|_",
      candidateId: "cand_1",
    };
    bus.emit(evt);
    expect(a).toHaveLength(1);
    expect(any).toHaveLength(1);

    // other kinds don't reach the typed listener
    bus.emit({
      kind: "l2.failed",
      episodeId: "ep_1" as any,
      stage: "test",
      error: { code: "X", message: "m" },
    });
    expect(a).toHaveLength(1);
    expect(any).toHaveLength(2);

    off1();
    off2();
    bus.emit(evt);
    expect(a).toHaveLength(1);
    expect(any).toHaveLength(2);
  });

  it("swallows listener exceptions", () => {
    const bus = createL2EventBus();
    bus.on("l2.candidate.added", () => {
      throw new Error("boom");
    });
    expect(() =>
      bus.emit({
        kind: "l2.candidate.added",
        episodeId: "ep" as any,
        traceId: "tr" as any,
        signature: "_|_|_|_",
        candidateId: "c",
      }),
    ).not.toThrow();
  });
});
