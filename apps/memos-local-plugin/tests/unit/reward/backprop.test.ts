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
    reflection: null,
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

  it("V_T = R_human on the last step (boundary case)", () => {
    const t1 = makeTrace({ id: "t1", ts: now - 60_000, alpha: 0 });
    const t2 = makeTrace({ id: "t2", ts: now - 30_000, alpha: 0 });
    const t3 = makeTrace({ id: "t3", ts: now, alpha: 0 });

    const res = backprop({ traces: [t1, t2, t3], rHuman: 0.8, gamma: 0.9, decayHalfLifeDays: 30, now });
    expect(res.updates).toHaveLength(3);
    expect(res.updates[2]!.value).toBeCloseTo(0.8, 6);
  });

  it("pure γ-discount when α=0 everywhere", () => {
    const t1 = makeTrace({ id: "t1", ts: now - 2_000, alpha: 0 });
    const t2 = makeTrace({ id: "t2", ts: now - 1_000, alpha: 0 });
    const t3 = makeTrace({ id: "t3", ts: now, alpha: 0 });

    const res = backprop({ traces: [t1, t2, t3], rHuman: 1.0, gamma: 0.9, decayHalfLifeDays: 365, now });
    // V3 = 1, V2 = 0.9 * 1 = 0.9, V1 = 0.9 * 0.9 = 0.81
    expect(res.updates[2]!.value).toBeCloseTo(1.0);
    expect(res.updates[1]!.value).toBeCloseTo(0.9);
    expect(res.updates[0]!.value).toBeCloseTo(0.81);
  });

  it("α=1 pulls that step straight to R_human (no discount)", () => {
    const t1 = makeTrace({ id: "t1", ts: now - 2_000, alpha: 1 }); // "aha!" step
    const t2 = makeTrace({ id: "t2", ts: now - 1_000, alpha: 0 });
    const t3 = makeTrace({ id: "t3", ts: now, alpha: 0 });

    const res = backprop({ traces: [t1, t2, t3], rHuman: 0.6, gamma: 0.5, decayHalfLifeDays: 365, now });
    expect(res.updates[0]!.value).toBeCloseTo(0.6); // 1·R + 0·γ·… = R
  });

  it("mixes α between 0 and 1 using the V7 formula", () => {
    const t1 = makeTrace({ id: "t1", ts: now - 2_000, alpha: 0.5 });
    const t2 = makeTrace({ id: "t2", ts: now - 1_000, alpha: 0 });
    const t3 = makeTrace({ id: "t3", ts: now, alpha: 0 });

    const r = 1.0;
    const gamma = 0.9;
    const res = backprop({ traces: [t1, t2, t3], rHuman: r, gamma, decayHalfLifeDays: 365, now });
    const v3 = r;
    const v2 = 0 * r + 1 * gamma * v3; // 0.9
    const v1 = 0.5 * r + 0.5 * gamma * v2; // 0.5 + 0.5·0.81 = 0.905
    expect(res.updates[2]!.value).toBeCloseTo(v3, 6);
    expect(res.updates[1]!.value).toBeCloseTo(v2, 6);
    expect(res.updates[0]!.value).toBeCloseTo(v1, 6);
  });

  it("clamps R_human and γ to their legal ranges", () => {
    const t = makeTrace({ id: "t", ts: now, alpha: 0 });
    const res = backprop({ traces: [t], rHuman: 5 /* > 1 */, gamma: 2 /* > 1 */, decayHalfLifeDays: 1, now });
    expect(res.updates[0]!.value).toBeCloseTo(1);
    expect(res.echoParams.gamma).toBeCloseTo(1);

    const res2 = backprop({ traces: [t], rHuman: -5, gamma: -1, decayHalfLifeDays: 1, now });
    expect(res2.updates[0]!.value).toBeCloseTo(-1);
    expect(res2.echoParams.gamma).toBeCloseTo(0);
  });

  it("priority = max(V, 0) · decay(Δt)", () => {
    const halfLife = 30; // days
    const t1 = makeTrace({ id: "t1", ts: now - 30 * 86_400_000, alpha: 0 }); // 1 half-life ago
    const t2 = makeTrace({ id: "t2", ts: now, alpha: 0 });

    const res = backprop({ traces: [t1, t2], rHuman: 1.0, gamma: 1.0, decayHalfLifeDays: halfLife, now });
    // V1 = γ·V2 = 1·1 = 1, decay = 0.5 → priority = 0.5
    expect(res.updates[0]!.value).toBeCloseTo(1, 6);
    expect(res.updates[0]!.priority).toBeCloseTo(0.5, 6);
    // V2 = 1, decay = 1 → priority = 1
    expect(res.updates[1]!.priority).toBeCloseTo(1, 6);
  });

  it("negative V produces zero priority (V7 §3.3 max(V,0))", () => {
    const t = makeTrace({ id: "t", ts: now, alpha: 1 });
    const res = backprop({ traces: [t], rHuman: -0.8, gamma: 0.9, decayHalfLifeDays: 30, now });
    expect(res.updates[0]!.value).toBeCloseTo(-0.8);
    expect(res.updates[0]!.priority).toBe(0);
  });

  it("empty trace list returns zeros without throwing", () => {
    const res = backprop({ traces: [], rHuman: 0.5, gamma: 0.9, decayHalfLifeDays: 30, now });
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
