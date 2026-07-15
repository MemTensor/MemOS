import { describe, it, expect } from "vitest";

import { createSkillEventBus } from "../../../core/skill/events.js";
import type { SkillEvent } from "../../../core/skill/types.js";
import type { SkillId } from "../../../core/types.js";

describe("skill/events", () => {
  it("delivers targeted events + wildcard, dedupes unsubscribe", () => {
    const bus = createSkillEventBus();
    const seen: SkillEvent[] = [];
    const any: SkillEvent[] = [];

    const off1 = bus.on("skill.crystallized", (e) => seen.push(e));
    const off2 = bus.onAny((e) => any.push(e));

    const evt: SkillEvent = {
      kind: "skill.crystallized",
      at: 1,
      skillId: "sk_1" as SkillId,
      name: "x",
      policyId: "po_1",
      status: "candidate",
    };
    bus.emit(evt);
    expect(seen).toHaveLength(1);
    expect(any).toHaveLength(1);

    off1();
    off2();
    bus.emit(evt);
    expect(seen).toHaveLength(1);
    expect(any).toHaveLength(1);
    expect(bus.listenerCount()).toBe(0);
  });

  it("logs listener errors without crashing other listeners", () => {
    const bus = createSkillEventBus();
    const called: string[] = [];
    bus.on("skill.archived", () => {
      throw new Error("boom");
    });
    bus.on("skill.archived", () => called.push("second"));
    bus.emit({
      kind: "skill.archived",
      at: 1,
      skillId: "sk_1" as SkillId,
      reason: "manual",
    });
    expect(called).toEqual(["second"]);
  });
});
