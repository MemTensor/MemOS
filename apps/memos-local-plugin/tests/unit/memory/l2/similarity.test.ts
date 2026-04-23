/**
 * Unit tests for `core/memory/l2/similarity`.
 */

import { describe, expect, it } from "vitest";

import {
  arithmeticMeanValue,
  centroid,
  tracePolicySimilarity,
  valueWeightedMean,
} from "../../../../core/memory/l2/similarity.js";
import type { EmbeddingVector, PolicyRow, TraceRow } from "../../../../core/types.js";

function vec(values: readonly number[]): EmbeddingVector {
  return new Float32Array(values) as unknown as EmbeddingVector;
}

function mkTrace(partial: Partial<TraceRow> = {}): TraceRow {
  return {
    id: "tr_1" as TraceRow["id"],
    episodeId: "ep_1" as TraceRow["episodeId"],
    sessionId: "s_1" as TraceRow["sessionId"],
    ts: 0 as TraceRow["ts"],
    userText: "",
    agentText: "",
    toolCalls: [],
    reflection: null,
    value: 0,
    alpha: 0.5 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    schemaVersion: 1,
    ...partial,
  };
}

function mkPolicy(partial: Partial<PolicyRow> = {}): PolicyRow {
  return {
    id: "po_1" as PolicyRow["id"],
    title: "t",
    trigger: "when x",
    procedure: "do y",
    verification: "check z",
    boundary: "not in q",
    support: 1,
    gain: 0.2,
    status: "active",
    sourceEpisodeIds: [],
    inducedBy: "unit-test",
    vec: null,
    createdAt: 0 as PolicyRow["createdAt"],
    updatedAt: 0 as PolicyRow["updatedAt"],
    ...partial,
  };
}

describe("memory/l2/similarity", () => {
  it("tracePolicySimilarity returns 0 when no vectors available", () => {
    const r = tracePolicySimilarity(mkTrace(), mkPolicy(), null);
    expect(r.cosine).toBe(0);
    expect(r.score).toBe(0.0);
  });

  it("perfectly aligned vectors + shared tags saturate towards 1", () => {
    const v = vec([1, 0]);
    const r = tracePolicySimilarity(
      mkTrace({ vecSummary: v, tags: ["docker", "pip"] }),
      mkPolicy({ vec: v, trigger: "docker pip thing" }),
      { primaryTag: "docker", secondaryTag: "pip", tool: "_", errCode: "_" },
    );
    expect(r.cosine).toBeCloseTo(1, 5);
    expect(r.score).toBeGreaterThanOrEqual(0.9);
  });

  it("orthogonal vectors with shared tags still expose a small bonus", () => {
    const r = tracePolicySimilarity(
      mkTrace({ vecSummary: vec([1, 0]), tags: ["docker"] }),
      mkPolicy({ vec: vec([0, 1]) }),
      { primaryTag: "docker", secondaryTag: "_", tool: "_", errCode: "_" },
    );
    expect(r.cosine).toBe(0);
    expect(r.score).toBeCloseTo(0.05, 5);
    expect(r.sharedComponents).toBe(1);
  });

  it("valueWeightedMean biases toward high-V traces", () => {
    const traces = [
      mkTrace({ value: 0.9 }),
      mkTrace({ value: 0.1 }),
      mkTrace({ value: 0.8 }),
    ];
    const avg = arithmeticMeanValue(traces);
    const weighted = valueWeightedMean(traces, 0.3);
    expect(avg).toBeCloseTo(0.6, 5);
    expect(weighted).toBeGreaterThan(avg);
  });

  it("valueWeightedMean equals arithmetic mean with equal values", () => {
    const traces = [
      mkTrace({ value: 0.5 }),
      mkTrace({ value: 0.5 }),
      mkTrace({ value: 0.5 }),
    ];
    expect(valueWeightedMean(traces, 0.1)).toBeCloseTo(0.5, 5);
  });

  it("centroid averages vectors and handles nulls gracefully", () => {
    const c = centroid([vec([1, 2]), vec([3, 4]), null])!;
    expect(Array.from(c as unknown as number[])).toEqual([2, 3]);
    expect(centroid([null, null])).toBeNull();
  });
});
