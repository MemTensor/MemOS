import { describe, expect, it } from "vitest";

import {
  cosine,
  decodeVector,
  encodeVector,
  scanAndTopK,
  topKCosine,
} from "../../../core/storage/index.js";
import { makeTmpDb } from "../../helpers/tmp-db.js";

function vec(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

describe("storage/vector codec", () => {
  it("round-trips a Float32Array through encode/decode", () => {
    const src = vec([0.1, -0.2, 0.3, 1e-7]);
    const buf = encodeVector(src);
    expect(Buffer.isBuffer(buf)).toBe(true);
    const out = decodeVector(buf)!;
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) {
      expect(out[i]).toBeCloseTo(src[i]!, 6);
    }
  });

  it("decodes null and zero-length safely", () => {
    expect(decodeVector(null)).toBeNull();
    expect(decodeVector(undefined)).toBeNull();
    expect(decodeVector(Buffer.alloc(0))!.length).toBe(0);
  });

  it("throws on misaligned buffers", () => {
    expect(() => decodeVector(Buffer.from([1, 2, 3]))).toThrow(/aligned to float32/);
  });
});

describe("storage/vector math", () => {
  it("computes cosine similarity in [-1, 1]", () => {
    expect(cosine(vec([1, 0]), vec([1, 0]))).toBeCloseTo(1);
    expect(cosine(vec([1, 0]), vec([-1, 0]))).toBeCloseTo(-1);
    expect(cosine(vec([1, 0]), vec([0, 1]))).toBeCloseTo(0);
  });

  it("cosine returns 0 for zero vectors (no NaN)", () => {
    expect(cosine(vec([0, 0]), vec([0, 0]))).toBe(0);
    expect(cosine(vec([0, 0]), vec([1, 1]))).toBe(0);
  });
});

describe("storage/vector topK", () => {
  it("returns top-K in descending score order, stable on ties", () => {
    const rows = [
      { id: "a", vec: vec([1, 0]) },
      { id: "b", vec: vec([0.9, 0.1]) },
      { id: "c", vec: vec([0.5, 0.5]) },
      { id: "d", vec: vec([-1, 0]) },
      { id: "e", vec: vec([0.9, 0.1]) }, // same as b
    ];
    const top3 = topKCosine(vec([1, 0]), rows, 3);
    expect(top3.length).toBe(3);
    expect(top3[0]!.id).toBe("a");
    // b and e tie; the order between them is allowed to vary, but d (negative)
    // must not appear.
    const ids = top3.map((h) => h.id);
    expect(ids).not.toContain("d");
  });

  it("handles k=0 and empty input", () => {
    expect(topKCosine(vec([1]), [], 3)).toEqual([]);
    expect(topKCosine(vec([1]), [{ id: "x", vec: vec([1]) }], 0)).toEqual([]);
  });

  it("skips rows with mismatched dimensions instead of throwing", () => {
    const rows = [
      { id: "ok", vec: vec([1, 0]) },
      { id: "bad", vec: vec([1, 0, 0]) },
    ];
    const hits = topKCosine(vec([1, 0]), rows, 5);
    expect(hits.map((h) => h.id)).toEqual(["ok"]);
  });
});

describe("storage/vector scanAndTopK against a live DB", () => {
  it("finds the most similar row among stored vectors", () => {
    const { db, repos, cleanup } = makeTmpDb();
    try {
      // Insert a session + episode + two policies with canned vectors.
      repos.sessions.upsert({
        id: "s",
        agent: "openclaw",
        startedAt: 1,
        lastSeenAt: 1,
        meta: {},
      });
      repos.episodes.insert({
        id: "e",
        sessionId: "s",
        startedAt: 1,
        endedAt: null,
        traceIds: [],
        rTask: null,
        status: "open",
      });

      repos.policies.upsert({
        id: "p_match",
        title: "match",
        trigger: "",
        procedure: "",
        verification: "",
        boundary: "",
        support: 0,
        gain: 0,
        status: "active",
        sourceEpisodeIds: [],
        inducedBy: "",
        decisionGuidance: { preference: [], antiPattern: [] },
        vec: vec([1, 0, 0]),
        createdAt: 1,
        updatedAt: 1,
      });
      repos.policies.upsert({
        id: "p_far",
        title: "far",
        trigger: "",
        procedure: "",
        verification: "",
        boundary: "",
        support: 0,
        gain: 0,
        status: "active",
        sourceEpisodeIds: [],
        inducedBy: "",
        decisionGuidance: { preference: [], antiPattern: [] },
        vec: vec([-1, 0, 0]),
        createdAt: 1,
        updatedAt: 1,
      });

      const hits = scanAndTopK(
        db,
        "policies",
        ["title"],
        vec([1, 0, 0]),
        2,
        { vecColumn: "vec", where: "vec IS NOT NULL" },
      );
      expect(hits[0]!.id).toBe("p_match");
      expect(hits[0]!.score).toBeCloseTo(1);
      expect(hits[1]!.id).toBe("p_far");
    } finally {
      cleanup();
    }
  });
});
