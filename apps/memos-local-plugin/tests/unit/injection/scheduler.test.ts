import { describe, expect, it } from "vitest";

import { scheduleInjection } from "../../../core/injection/scheduler.js";
import type { IntentDecision } from "../../../core/session/types.js";

const baseIntent: IntentDecision = {
  kind: "task",
  confidence: 0.9,
  reason: "test",
  retrieval: { tier1: true, tier2: true, tier3: true },
  signals: ["test"],
};

function planFor(intent: IntentDecision, relation?: Parameters<typeof scheduleInjection>[0]["relation"]) {
  return scheduleInjection({
    userText: "test",
    sessionId: "s1",
    episodeId: "ep1",
    intent,
    relation,
  });
}

describe("injection/scheduler", () => {
  it("skips confident chitchat", () => {
    const plan = planFor({
      ...baseIntent,
      kind: "chitchat",
      confidence: 0.9,
      retrieval: { tier1: false, tier2: false, tier3: false },
    });

    expect(plan).toMatchObject({
      scenarioId: "CHITCHAT",
      entry: "turn_start_skip",
      prepend: false,
      wantTier1: false,
      wantTier2: false,
      wantTier3: false,
    });
  });

  it("does not skip low-confidence chitchat", () => {
    const plan = planFor({
      ...baseIntent,
      kind: "chitchat",
      confidence: 0.4,
      retrieval: { tier1: false, tier2: false, tier3: false },
    });

    expect(plan.entry).toBe("turn_start");
    expect(plan.scenarioId).toBe("UNKNOWN_SAFE");
    expect(plan.wantTier1).toBe(true);
    expect(plan.wantTier2).toBe(true);
    expect(plan.wantTier3).toBe(true);
  });

  it("skips meta commands", () => {
    const plan = planFor({
      ...baseIntent,
      kind: "meta",
      confidence: 0.98,
      retrieval: { tier1: false, tier2: false, tier3: false },
    });

    expect(plan.scenarioId).toBe("META");
    expect(plan.entry).toBe("turn_start_skip");
  });

  it("keeps memory probes on their intent tier gates", () => {
    const plan = planFor({
      ...baseIntent,
      kind: "memory_probe",
      retrieval: { tier1: true, tier2: true, tier3: false },
    });

    expect(plan).toMatchObject({
      scenarioId: "MEMORY_PROBE",
      entry: "turn_start",
      wantTier1: true,
      wantTier2: true,
      wantTier3: false,
    });
  });

  it("keeps unknown intent conservative", () => {
    const plan = planFor({
      ...baseIntent,
      kind: "unknown",
      confidence: 0,
      retrieval: { tier1: false, tier2: false, tier3: false },
    });

    expect(plan).toMatchObject({
      scenarioId: "UNKNOWN_SAFE",
      wantTier1: true,
      wantTier2: true,
      wantTier3: true,
    });
  });

  it("records relation-driven scenarios without changing tier gates", () => {
    const plan = planFor(baseIntent, "new_task");

    expect(plan).toMatchObject({
      scenarioId: "NEW_TASK",
      entry: "turn_start",
      wantTier1: true,
      wantTier2: true,
      wantTier3: true,
    });
  });
});
