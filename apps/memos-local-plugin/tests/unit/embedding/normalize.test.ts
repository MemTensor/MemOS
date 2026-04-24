import { beforeAll, describe, expect, it } from "vitest";

import { initTestLogger } from "../../../core/logger/index.js";
import { MemosError } from "../../../agent-contract/errors.js";
import {
  enforceDim,
  l2Normalize,
  postProcess,
  toFloat32,
} from "../../../core/embedding/normalize.js";

describe("embedding/normalize", () => {
  beforeAll(() => initTestLogger());

  it("toFloat32 roundtrips values", () => {
    const f = toFloat32([0.5, -0.25, 1.0]);
    expect(f).toBeInstanceOf(Float32Array);
    expect(f.length).toBe(3);
    expect(f[0]).toBeCloseTo(0.5);
    expect(f[1]).toBeCloseTo(-0.25);
  });

  it("enforceDim passes through equal-length vectors", () => {
    const v = [1, 2, 3, 4];
    expect(enforceDim(v, 4, { provider: "x", model: "y" })).toBe(v);
  });

  it("enforceDim truncates when provider returns more dims", () => {
    const v = [1, 2, 3, 4, 5];
    expect(enforceDim(v, 3, { provider: "x", model: "y" })).toEqual([1, 2, 3]);
  });

  it("enforceDim throws MemosError when provider returns too few dims", () => {
    try {
      enforceDim([1, 2], 4, { provider: "x", model: "y" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe("embedding_unavailable");
      expect((err as MemosError).details).toMatchObject({
        provider: "x",
        got: 2,
        expected: 4,
      });
    }
  });

  it("l2Normalize produces a unit vector", () => {
    const v = new Float32Array([3, 4]);
    const n = l2Normalize(v);
    const len = Math.sqrt(n[0]! ** 2 + n[1]! ** 2);
    expect(len).toBeCloseTo(1.0, 5);
    expect(n[0]).toBeCloseTo(0.6, 5);
    expect(n[1]).toBeCloseTo(0.8, 5);
  });

  it("l2Normalize returns all-zero input unchanged", () => {
    const v = new Float32Array([0, 0, 0]);
    const n = l2Normalize(v);
    expect(Array.from(n)).toEqual([0, 0, 0]);
  });

  it("postProcess pipelines dim enforce + Float32 + normalize", () => {
    const raw = [
      [3, 4, 9], // we'll truncate to 2, then L2-normalize → [0.6, 0.8]
      [1, 0, 2],
    ];
    const out = postProcess(raw, {
      dimensions: 2,
      provider: "p",
      model: "m",
      normalize: true,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0]![0]).toBeCloseTo(0.6, 5);
    expect(out[0]![1]).toBeCloseTo(0.8, 5);
    expect(out[1]![0]).toBeCloseTo(1.0, 5);
  });

  it("postProcess can skip normalization", () => {
    const out = postProcess([[2, 0]], {
      dimensions: 2,
      provider: "p",
      model: "m",
      normalize: false,
    });
    expect(out[0]![0]).toBeCloseTo(2, 5);
  });
});
