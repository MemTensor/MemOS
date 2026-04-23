import { describe, it, expect } from "vitest";

import {
  contextHashOf,
  createFailureSignals,
} from "../../../core/feedback/signals.js";
import type {
  EpochMs,
  SessionId,
} from "../../../core/types.js";
import { rootLogger } from "../../../core/logger/index.js";
import { makeFeedbackConfig } from "./_helpers.js";

function rec(overrides: {
  toolId?: string;
  context?: string;
  step: number;
  reason?: string;
  ts?: number;
}) {
  return {
    toolId: overrides.toolId ?? "pip.install",
    context: overrides.context ?? "alpine",
    step: overrides.step,
    reason: overrides.reason ?? "MODULE_NOT_FOUND",
    ts: (overrides.ts ?? 0) as EpochMs,
  };
}

describe("feedback/signals", () => {
  it("contextHashOf is deterministic and collision-resistant", () => {
    expect(contextHashOf("pip.install", "alpine")).toBe(
      contextHashOf("pip.install", "alpine"),
    );
    expect(contextHashOf("pip.install", "alpine")).not.toBe(
      contextHashOf("pip.install", "ubuntu"),
    );
    expect(contextHashOf("pip.install", "alpine")).toHaveLength(16);
  });

  it("raises a burst after threshold consecutive failures", () => {
    const signals = createFailureSignals({
      config: makeFeedbackConfig({ failureThreshold: 3, failureWindow: 5 }),
      log: rootLogger.child({ channel: "test.signals" }),
    });

    expect(signals.recordFailure(rec({ step: 1 }))).toBeNull();
    expect(signals.recordFailure(rec({ step: 2 }))).toBeNull();
    const burst = signals.recordFailure(rec({ step: 3 }));
    expect(burst).not.toBeNull();
    expect(burst?.failureCount).toBe(3);
    expect(burst?.contextHash).toBe(
      contextHashOf("pip.install", "alpine"),
    );
  });

  it("uses a rolling step-window and prunes older failures", () => {
    const signals = createFailureSignals({
      config: makeFeedbackConfig({ failureThreshold: 3, failureWindow: 3 }),
      log: rootLogger.child({ channel: "test.signals" }),
    });

    expect(signals.recordFailure(rec({ step: 1 }))).toBeNull();
    expect(signals.recordFailure(rec({ step: 2 }))).toBeNull();
    // Step 5 pushes the window to [3..5], so step 1 + 2 fall out.
    expect(signals.recordFailure(rec({ step: 5 }))).toBeNull();
    expect(signals.recordFailure(rec({ step: 6 }))).toBeNull();
    const burst = signals.recordFailure(rec({ step: 7 }));
    expect(burst?.failureCount).toBe(3);
    expect(
      burst!.occurrences.map((o) => o.step).sort((a, b) => a - b),
    ).toEqual([5, 6, 7]);
  });

  it("a success in the same window suppresses the burst", () => {
    const signals = createFailureSignals({
      config: makeFeedbackConfig({ failureThreshold: 3, failureWindow: 5 }),
      log: rootLogger.child({ channel: "test.signals" }),
    });

    expect(signals.recordFailure(rec({ step: 1 }))).toBeNull();
    expect(signals.recordFailure(rec({ step: 2 }))).toBeNull();
    signals.recordSuccess("pip.install", "alpine", 3);
    expect(signals.recordFailure(rec({ step: 4 }))).toBeNull();
    // Two remaining failures < threshold because step 1..3 were pruned on success.
    const peeked = signals.peek("pip.install", "alpine");
    expect(peeked?.failureCount ?? 0).toBeLessThan(3);
  });

  it("clear() wipes state for a single contextHash only", () => {
    const signals = createFailureSignals({
      config: makeFeedbackConfig({ failureThreshold: 2, failureWindow: 5 }),
      log: rootLogger.child({ channel: "test.signals" }),
    });
    signals.recordFailure(rec({ step: 1 }));
    signals.recordFailure(rec({ toolId: "pip.build", step: 1 }));
    const hashA = contextHashOf("pip.install", "alpine");
    signals.clear(hashA);
    expect(signals.peek("pip.install", "alpine")).toBeNull();
    expect(signals.peek("pip.build", "alpine")?.failureCount).toBe(1);
    signals.clear();
    expect(signals.peek("pip.build", "alpine")).toBeNull();
  });

  it("stats() counts live states and total failure occurrences", () => {
    const signals = createFailureSignals({
      config: makeFeedbackConfig({ failureThreshold: 9, failureWindow: 9 }),
      log: rootLogger.child({ channel: "test.signals" }),
    });
    signals.recordFailure(rec({ step: 1 }));
    signals.recordFailure(rec({ step: 2 }));
    signals.recordFailure(rec({ toolId: "pip.build", step: 1 }));
    expect(signals.stats().states).toBe(2);
    expect(signals.stats().totalFailures).toBe(3);
  });

  it("records session/episode metadata on the burst occurrences", () => {
    const signals = createFailureSignals({
      config: makeFeedbackConfig({ failureThreshold: 2, failureWindow: 5 }),
      log: rootLogger.child({ channel: "test.signals" }),
    });
    signals.recordFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 1,
      reason: "boom",
      ts: 0 as EpochMs,
      sessionId: "s1" as SessionId,
    });
    const burst = signals.recordFailure({
      toolId: "pip.install",
      context: "alpine",
      step: 2,
      reason: "boom",
      ts: 0 as EpochMs,
      sessionId: "s1" as SessionId,
    });
    expect(burst).not.toBeNull();
    expect(burst!.occurrences.every((o) => o.sessionId === "s1")).toBe(true);
  });
});
