import { describe, expect, it } from "vitest";

import { backprop, priorityFor } from "../../../core/reward/backprop.js";
import type { EpochMs, TraceRow } from "../../../core/types.js";

function makeTrace(partial: Partial<TraceRow> & { id: string; ts: number; alpha?: number }): TraceRow {
  return {
    id: partial.id as TraceRow["id"],
    episodeId: ("ep_1" as unknown) as TraceRow["episodeId"],
    sessionId: ("s_1" as unknown) as TraceRow["sessionId"],
    ts: partial.ts as EpochMs,
    userText: "",
    agentText: "",
    toolCalls: [],
    reflection: partial.reflection ?? null,
    value: 0,
    alpha: (partial.alpha ?? 0) as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    turnId: 0 as never,
    schemaVersion: 1,
  };
}

describe("reward/backprop", () => {
  const now = (1_700_000_000_000) as EpochMs;

  it("uses normalized credit assignment and conserves ΣV=R", () => {
    const traces = [
      makeTrace({ id: "t1", ts: now - 5_000, reflection: "RELATED" }),
      makeTrace({ id: "t2", ts: now - 4_000, reflection: "RELATED" }),
      makeTrace({ id: "t3", ts: now - 3_000, reflection: "IRRELEVANT" }),
      makeTrace({ id: "t4", ts: now - 2_000, reflection: "RELATED" }),
      makeTrace({ id: "t5", ts: now - 1_000, reflection: "RELATED" }),
    ];
    const res = backprop({
      traces,
      rHuman: 0.5,
      gamma: 0.9,
      lambda: 0.5,
      delta: 0,
      decayHalfLifeDays: 30,
      now,
    });
    const values = res.updates.map((u) => u.value);
    expect(values[2]).toBe(0);
    const sum = values.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(0.5, 6);
  });

  it("applies recovery boost to first non-zero step after zero", () => {
    const traces = [
      makeTrace({ id: "t1", ts: now - 6_000, reflection: "RELATED" }),
      makeTrace({ id: "t2", ts: now - 5_000, reflection: "RELATED" }),
      makeTrace({ id: "t3", ts: now - 4_000, reflection: "IRRELEVANT" }),
      makeTrace({ id: "t4", ts: now - 3_000, reflection: "PIVOTAL" }),
      makeTrace({ id: "t5", ts: now - 2_000, reflection: "RELATED" }),
      makeTrace({ id: "t6", ts: now - 1_000, reflection: "PIVOTAL" }),
    ];
    const res = backprop({
      traces,
      rHuman: 1,
      gamma: 0.9,
      lambda: 0,
      delta: 0.1,
      decayHalfLifeDays: 30,
      now,
    });
    // With lambda=0, positional factor is flat, so recovery decides t4 > t6.
    expect(res.updates[3]!.value).toBeGreaterThan(res.updates[5]!.value);
  });

  it("keeps negative reward proportional and conserved", () => {
    const traces = [
      makeTrace({ id: "t1", ts: now - 3_000, reflection: "RELATED" }),
      makeTrace({ id: "t2", ts: now - 2_000, reflection: "PIVOTAL" }),
      makeTrace({ id: "t3", ts: now - 1_000, reflection: "RELATED" }),
    ];
    const res = backprop({
      traces,
      rHuman: -0.8,
      gamma: 0.9,
      lambda: 0.5,
      delta: 0.1,
      decayHalfLifeDays: 30,
      now,
    });
    const sum = res.updates.reduce((a, b) => a + b.value, 0);
    expect(sum).toBeCloseTo(-0.8, 6);
    expect(res.updates.every((u) => u.value <= 0)).toBe(true);
  });

  it("falls back to alpha when reflection is missing", () => {
    const traces = [
      makeTrace({ id: "t1", ts: now - 2_000, reflection: null, alpha: 1 }),
      makeTrace({ id: "t2", ts: now - 1_000, reflection: null, alpha: 0 }),
    ];
    const res = backprop({
      traces,
      rHuman: 1,
      gamma: 0.9,
      lambda: 0.5,
      delta: 0,
      decayHalfLifeDays: 30,
      now,
    });
    expect(res.updates[0]!.value).toBeCloseTo(1, 6);
    expect(res.updates[1]!.value).toBe(0);
  });

  it("returns all-zero values when Σw=0 (all irrelevant)", () => {
    const traces = [
      makeTrace({ id: "t1", ts: now - 2_000, reflection: "IRRELEVANT" }),
      makeTrace({ id: "t2", ts: now - 1_000, reflection: "IRRELEVANT" }),
    ];
    const res = backprop({
      traces,
      rHuman: 0.9,
      gamma: 0.9,
      lambda: 0.5,
      delta: 0.1,
      decayHalfLifeDays: 30,
      now,
    });
    expect(res.updates[0]!.value).toBe(0);
    expect(res.updates[1]!.value).toBe(0);
  });

  it("clamps R_human and γ to their legal ranges", () => {
    const t = makeTrace({ id: "t", ts: now, reflection: "PIVOTAL", alpha: 0 });
    const res = backprop({
      traces: [t],
      rHuman: 5 /* > 1 */,
      gamma: 2 /* > 1 */,
      lambda: 2,
      delta: -1,
      decayHalfLifeDays: 1,
      now,
    });
    expect(res.updates[0]!.value).toBeCloseTo(1);
    expect(res.echoParams.gamma).toBeCloseTo(1);
    expect(res.echoParams.lambda).toBeCloseTo(1);
    expect(res.echoParams.delta).toBeCloseTo(0);

    const res2 = backprop({
      traces: [t],
      rHuman: -5,
      gamma: -1,
      lambda: -1,
      delta: 0,
      decayHalfLifeDays: 1,
      now,
    });
    expect(res2.updates[0]!.value).toBeCloseTo(-1);
    expect(res2.echoParams.gamma).toBeCloseTo(0);
    expect(res2.echoParams.lambda).toBeCloseTo(0);
  });

  it("zero-α traces collapse to V=0 and priority=0 (overrides capture seed)", () => {
    const t1 = makeTrace({ id: "t1", ts: now - 30 * 86_400_000, reflection: "IRRELEVANT" });
    const t2 = makeTrace({ id: "t2", ts: now, reflection: "IRRELEVANT" });
    const res = backprop({
      traces: [t1, t2],
      rHuman: 1.0,
      gamma: 1.0,
      lambda: 1,
      delta: 0,
      decayHalfLifeDays: 30,
      now,
    });
    expect(res.updates[0]!.value).toBe(0);
    expect(res.updates[1]!.value).toBe(0);
    expect(res.updates[0]!.priority).toBe(0);
    expect(res.updates[1]!.priority).toBe(0);
  });

  it("priority = max(V, 0) · decay(Δt) under normalized weights", () => {
    const halfLife = 30; // days
    // Two equal-weight RELATED traces with flat positional (lambda=0):
    //   positional = 1, recovery=0, w = 0.5 each, S = 1 → V_t = R/2 = 0.5.
    // Decay: t1 is one half-life old → 0.5; t2 is current → 1.0.
    const t1 = makeTrace({ id: "t1", ts: now - 30 * 86_400_000, reflection: "RELATED" });
    const t2 = makeTrace({ id: "t2", ts: now, reflection: "RELATED" });
    const res = backprop({
      traces: [t1, t2],
      rHuman: 1.0,
      gamma: 1.0,
      lambda: 0,
      delta: 0,
      decayHalfLifeDays: halfLife,
      now,
    });
    expect(res.updates[0]!.value).toBeCloseTo(0.5, 6);
    expect(res.updates[1]!.value).toBeCloseTo(0.5, 6);
    expect(res.updates[0]!.priority).toBeCloseTo(0.25, 6); // 0.5 · 0.5
    expect(res.updates[1]!.priority).toBeCloseTo(0.5, 6); // 0.5 · 1
  });

  it("negative V produces zero priority (V7 §3.3 max(V,0))", () => {
    const t = makeTrace({ id: "t", ts: now, alpha: 1 });
    const res = backprop({
      traces: [t],
      rHuman: -0.8,
      gamma: 0.9,
      lambda: 0.5,
      delta: 0.1,
      decayHalfLifeDays: 30,
      now,
    });
    expect(res.updates[0]!.value).toBeCloseTo(-0.8);
    expect(res.updates[0]!.priority).toBe(0);
  });

  it("empty trace list returns zeros without throwing", () => {
    const res = backprop({
      traces: [],
      rHuman: 0.5,
      gamma: 0.9,
      lambda: 0.5,
      delta: 0.1,
      decayHalfLifeDays: 30,
      now,
    });
    expect(res.updates).toEqual([]);
    expect(res.meanAbsValue).toBe(0);
    expect(res.maxPriority).toBe(0);
  });

  it("priorityFor is the same formula as backprop's priority", () => {
    const ts = now - 30 * 86_400_000;
    const p1 = priorityFor(1.0, ts, 30, now);
    expect(p1).toBeCloseTo(0.5, 6);
    const pNeg = priorityFor(-0.9, ts, 30, now);
    expect(pNeg).toBe(0);
  });
});
