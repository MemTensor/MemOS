import { describe, it, expect } from "vitest";
import { rrfFuse } from "../src/recall/rrf";
import { applyRecencyDecay } from "../src/recall/recency";

describe("rrfFuse", () => {
  it("should merge two ranked lists via RRF", () => {
    const list1 = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.8 },
      { id: "c", score: 0.7 },
    ];
    const list2 = [
      { id: "b", score: 0.95 },
      { id: "a", score: 0.85 },
      { id: "d", score: 0.6 },
    ];

    const scores = rrfFuse([list1, list2], 60);

    expect(scores.has("a")).toBe(true);
    expect(scores.has("b")).toBe(true);
    expect(scores.has("c")).toBe(true);
    expect(scores.has("d")).toBe(true);

    // b appears at rank 1 in list1 and rank 0 in list2 → highest combined
    // a appears at rank 0 in list1 and rank 1 in list2
    // Both should have equal RRF scores since rank(a,l1)=0,rank(a,l2)=1 same as rank(b,l1)=1,rank(b,l2)=0
    expect(scores.get("a")).toBeCloseTo(scores.get("b")!, 6);
  });

  it("should handle empty lists", () => {
    const scores = rrfFuse([[], []], 60);
    expect(scores.size).toBe(0);
  });

  it("should handle single list", () => {
    const list = [{ id: "x", score: 1 }];
    const scores = rrfFuse([list], 60);
    expect(scores.has("x")).toBe(true);
    expect(scores.get("x")).toBeCloseTo(1 / 61, 6);
  });
});

describe("applyRecencyDecay", () => {
  it("should give higher scores to recent items", () => {
    const now = Date.now();
    const candidates = [
      { id: "recent", score: 1.0, createdAt: now - 1 * 24 * 3600_000 },
      { id: "old", score: 1.0, createdAt: now - 30 * 24 * 3600_000 },
    ];

    const result = applyRecencyDecay(candidates, 14, now);
    const recent = result.find((r) => r.id === "recent")!;
    const old = result.find((r) => r.id === "old")!;

    expect(recent.score).toBeGreaterThan(old.score);
  });

  it("should not zero out old items (alpha floor)", () => {
    const now = Date.now();
    const candidates = [
      { id: "ancient", score: 1.0, createdAt: now - 365 * 24 * 3600_000 },
    ];

    const result = applyRecencyDecay(candidates, 14, now);
    expect(result[0].score).toBeGreaterThan(0.2);
  });

  it("should preserve relative ordering when all same age", () => {
    const now = Date.now();
    const candidates = [
      { id: "a", score: 0.9, createdAt: now },
      { id: "b", score: 0.5, createdAt: now },
    ];

    const result = applyRecencyDecay(candidates, 14, now);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });
});
