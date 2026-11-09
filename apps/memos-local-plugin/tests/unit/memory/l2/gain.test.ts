/**
 * Unit tests for `core/memory/l2/gain`.
 */

import { describe, expect, it, vi } from "vitest";

import { adaptiveBaseline, applyGain, computeGain, MIN_ADAPTIVE_BASELINE, nextStatus, smoothGain } from "../../../../core/memory/l2/gain.js";
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
    turnId: 0 as never,
    schemaVersion: 1,
  };
}

describe("memory/l2/gain", () => {
  it("computeGain uses an adaptive shrinkage baseline for low-value trace pools", () => {
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
    expect(g.poolMean).toBeCloseTo(0.425, 5);
    expect(g.baseline).toBeCloseTo(0.425, 5);
    expect(g.gain).toBeCloseTo(0.35357143, 5);
    expect(g.withCount).toBe(2);
  });

  it("keeps the neutral baseline for high-value trace pools", () => {
    const g = computeGain(
      {
        policyId: "po_1" as PolicyId,
        withTraces: [mkTrace(0.8), mkTrace(0.7)],
        withoutTraces: [mkTrace(0.6), mkTrace(0.55)],
      },
      { tauSoftmax: 0.5 },
    );
    expect(g.poolMean).toBeGreaterThan(0.5);
    expect(g.baseline).toBeCloseTo(0.5, 5);
  });

  it("adaptiveBaseline tracks poolMean across the v2.0.7 backprop V distribution (regression for #2364)", () => {
    // v2.0.7 backprop V values cluster in the 0.02–0.5 band (see
    // core/config/defaults.ts "V values for typical multi-step turns are
    // clustered around 0.02–0.5"). At these poolMeans the baseline must
    // *actually* adapt instead of clamping to a fixed floor.
    expect(adaptiveBaseline(0.02)).toBeCloseTo(0.02, 6);
    expect(adaptiveBaseline(0.05)).toBeCloseTo(0.05, 6);
    expect(adaptiveBaseline(0.15)).toBeCloseTo(0.15, 6);
    // Bounds still hold at both ends.
    expect(adaptiveBaseline(0.6)).toBeCloseTo(0.5, 6);
    expect(adaptiveBaseline(0)).toBeCloseTo(MIN_ADAPTIVE_BASELINE, 6);
    expect(adaptiveBaseline(Number.NaN)).toBeCloseTo(0.5, 6);
    // The floor must be low enough that the entire v2.0.7 V band
    // (documented as 0.02–0.5) is inside the adaptive branch, not below
    // it — otherwise adaptiveBaseline collapses to a constant floor and
    // policy/skill promotion stalls fleet-wide.
    expect(MIN_ADAPTIVE_BASELINE).toBeLessThanOrEqual(0.02);
  });

  it("computeGain follows poolMean when the pool sits in the v2.0.7 backprop V band (regression for #2364)", () => {
    // Typical v2.0.7 pool: with-set ~0.05–0.08, without-set ~0.02–0.05.
    // Before the fix, baseline clamped to 0.2 and gain went strongly
    // negative for these pools even though the with-set outperforms the
    // without-set by the reward distribution's own scale.
    const g = computeGain(
      {
        policyId: "po_v207" as PolicyId,
        withTraces: [mkTrace(0.06), mkTrace(0.05)],
        withoutTraces: [mkTrace(0.03), mkTrace(0.04)],
      },
      { tauSoftmax: 0.5 },
    );
    expect(g.poolMean).toBeCloseTo(0.045, 5);
    expect(g.baseline).toBeCloseTo(0.045, 5);
    // With baseline = 0.045 the blended without-mean sits close to the
    // empirical mean instead of being dragged up to 0.2, so the sign of
    // the gain reflects the with vs. without contrast rather than the
    // stale floor.
    expect(g.gain).toBeGreaterThan(0);
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
        poolMean: 0.35,
        baseline: 0.35,
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

  it("smoothGain preserves existing signal after the first update", () => {
    expect(
      smoothGain({ newGain: -0.15, currentGain: 0.1, alpha: 0.4, isFirst: false }),
    ).toBeCloseTo(0, 5);
    expect(
      smoothGain({ newGain: -0.15, currentGain: 0.1, alpha: 0.4, isFirst: true }),
    ).toBeCloseTo(-0.15, 5);
  });
});
