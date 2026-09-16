import { describe, expect, it } from "vitest";
import { contributionGainValues } from "../../../core/reward/gain-value.js";

describe("contribution gain values", () => {
  it("does not count zero credit toward the multiplier", () => {
    expect(contributionGainValues([0.3, 0.3, 0])).toEqual([0.6, 0.6, 0]);
  });
  it("clips without claiming clipped mean conservation", () => {
    expect(contributionGainValues([0.8, 0.2])).toEqual([1, 0.4]);
  });
  it("preserves negative and zero scores", () => {
    expect(contributionGainValues([-0.3, -0.3, 0])).toEqual([-0.6, -0.6, 0]);
    expect(contributionGainValues([0, 0])).toEqual([0, 0]);
  });
  it("removes equal-credit normalization dilution", () => {
    for (const value of contributionGainValues(Array(200).fill(0.003))) {
      expect(value).toBeCloseTo(0.6, 12);
    }
  });
  it("rejects invalid credit rather than converting it to neutral", () => {
    expect(() => contributionGainValues([NaN])).toThrow(RangeError);
    expect(() => contributionGainValues([1.1])).toThrow(RangeError);
  });
  it("contributor mean equals the input mean only before clipping", () => {
    // Unclipped: mean(V·N) = mean(V)·N equals R·N / N ... i.e. the helper
    // preserves the per-contributor mean when nothing clips.
    const unclipped = contributionGainValues([0.3, 0.3, 0]);
    const unclippedMean = unclipped.reduce((a, b) => a + b, 0) / unclipped.length;
    expect(unclippedMean).toBeCloseTo(0.2 * 2, 12); // (0.3·2 + 0.3·2 + 0)/3
    // Clipped: mean conservation is lost by design — gainValue≠N·V for the
    // clipped member, so the group mean no longer equals R.
    const clipped = contributionGainValues([0.8, 0.2]);
    const clippedMean = clipped.reduce((a, b) => a + b, 0) / clipped.length;
    expect(clippedMean).not.toBeCloseTo(0.5 * 2, 12);
  });
});
