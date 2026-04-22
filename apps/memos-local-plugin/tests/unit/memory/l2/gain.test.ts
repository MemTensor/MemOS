/**
 * Unit tests for `core/memory/l2/gain`.
 */

import { describe, expect, it, vi } from "vitest";

import { applyGain, computeGain, nextStatus } from "../../../../core/memory/l2/gain.js";
import type { PolicyId, TraceRow } from "../../../../core/types.js";

function mkTrace(value: number): TraceRow {
  return {
    id: `tr_${value.toFixed(2)}` as TraceRow["id"],
    episodeId: "ep" as TraceRow["episodeId"],
    sessionId: "s" as TraceRow["sessionId"],
    ts: 0 as TraceRow["ts"],
    userText: "",
    agentText: "",
    toolCalls: [],
    reflection: null,
    value,
    alpha: 0.5 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    schemaVersion: 1,
  };
}

describe("memory/l2/gain", () => {
  it("computeGain returns V_with − V_without using arithmetic mean for <3 traces", () => {
    const g = computeGain(
      {
        policyId: "po_1" as PolicyId,
        withTraces: [mkTrace(0.8), mkTrace(0.6)],
        withoutTraces: [mkTrace(0.2), mkTrace(0.1)],
      },
      { tauSoftmax: 0.5 },
    );
    expect(g.withMean).toBeCloseTo(0.7, 5);
    expect(g.withoutMean).toBeCloseTo(0.15, 5);
    expect(g.gain).toBeCloseTo(0.55, 5);
    expect(g.withCount).toBe(2);
  });

  it("uses value-weighted mean for the with-set when count ≥ 3", () => {
    const g = computeGain(
      {
        policyId: "po_1" as PolicyId,
        withTraces: [mkTrace(0.9), mkTrace(0.2), mkTrace(0.8)],
        withoutTraces: [mkTrace(0.0)],
      },
      { tauSoftmax: 0.25 },
    );
    expect(g.weightedWith).toBeGreaterThan(g.withMean); // biased to high-V entries
  });

  it("nextStatus promotes candidate → active when support + gain OK", () => {
    expect(
      nextStatus({
        currentStatus: "candidate",
        support: 3,
        gain: 0.2,
        thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
      }),
    ).toBe("active");
  });

  it("nextStatus keeps candidate if gain insufficient", () => {
    expect(
      nextStatus({
        currentStatus: "candidate",
        support: 4,
        gain: 0.1,
        thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
      }),
    ).toBe("candidate");
  });

  it("nextStatus archives active when gain drops below threshold", () => {
    expect(
      nextStatus({
        currentStatus: "active",
        support: 10,
        gain: -0.1,
        thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
      }),
    ).toBe("archived");
  });

  it("archived is sticky", () => {
    expect(
      nextStatus({
        currentStatus: "archived",
        support: 100,
        gain: 0.9,
        thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
      }),
    ).toBe("archived");
  });

  it("applyGain calls persist with the derived support/gain/status", () => {
    const persist = vi.fn();
    const out = applyGain({
      gain: {
        policyId: "po_7" as PolicyId,
        gain: 0.3,
        withMean: 0.5,
        withoutMean: 0.2,
        withCount: 4,
        withoutCount: 2,
        weightedWith: 0.55,
      },
      deltaSupport: 2,
      currentStatus: "candidate",
      currentSupport: 2,
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
      persist,
      now: 1_000,
    });
    expect(out.support).toBe(4);
    expect(out.status).toBe("active");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toMatchObject({
      policyId: "po_7",
      support: 4,
      gain: 0.3,
      status: "active",
      updatedAt: 1_000,
    });
  });
});
