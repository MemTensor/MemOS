import { describe, expect, it } from "vitest";

import { rank } from "../../../core/retrieval/ranker.js";
import type {
  EpisodeCandidate,
  RetrievalConfig,
  SkillCandidate,
  TraceCandidate,
  WorldModelCandidate,
} from "../../../core/retrieval/types.js";

const cfg: RetrievalConfig = {
  tier1TopK: 3,
  tier2TopK: 5,
  tier3TopK: 2,
  candidatePoolFactor: 4,
  weightCosine: 0.6,
  weightPriority: 0.4,
  mmrLambda: 0.7,
  includeLowValue: false,
  rrfConstant: 60,
  minSkillEta: 0.5,
  minTraceSim: 0.35,
  tagFilter: "auto",
  decayHalfLifeDays: 30,
};

const NOW = 1_700_000_000_000;

function vecOf(nums: number[]) {
  return Float32Array.from(nums) as unknown as Float32Array;
}

function skill(id: string, cos: number, eta: number, vec?: number[]): SkillCandidate {
  return {
    tier: "tier1",
    refKind: "skill",
    refId: id as never,
    cosine: cos,
    ts: NOW as never,
    vec: vec ? vecOf(vec) : null,
    skillName: `sk ${id}`,
    eta,
    status: "active",
    invocationGuide: "guide",
  };
}

function trace(id: string, cos: number, value: number, vec?: number[]): TraceCandidate {
  return {
    tier: "tier2",
    refKind: "trace",
    refId: id as never,
    cosine: cos,
    ts: NOW as never,
    vec: vec ? vecOf(vec) : null,
    value,
    priority: Math.max(0, value),
    episodeId: `ep-${id}` as never,
    sessionId: "s1" as never,
    vecKind: "summary",
    userText: "u",
    agentText: "a",
    summary: null,
    reflection: null,
    tags: [],
  };
}

function episode(id: string, cos: number, maxV: number): EpisodeCandidate {
  return {
    tier: "tier2",
    refKind: "episode",
    refId: id as never,
    cosine: cos,
    ts: NOW as never,
    vec: null,
    sessionId: "s1" as never,
    summary: "ep summary",
    maxValue: maxV,
    meanPriority: maxV,
  };
}

function world(id: string, cos: number): WorldModelCandidate {
  return {
    tier: "tier3",
    refKind: "world-model",
    refId: id as never,
    cosine: cos,
    ts: NOW as never,
    vec: null,
    title: id,
    body: "body",
    policyIds: [],
  };
}

describe("retrieval/ranker", () => {
  it("empty input returns empty", () => {
    const out = rank({
      tier1: [],
      tier2Traces: [],
      tier2Episodes: [],
      tier3: [],
      limit: 10,
      config: cfg,
      now: NOW,
    });
    expect(out.ranked.length).toBe(0);
  });

  it("seeds at least one pick per non-empty tier", () => {
    const out = rank({
      tier1: [skill("sk1", 0.9, 0.9)],
      tier2Traces: [trace("t1", 0.8, 0.5)],
      tier2Episodes: [],
      tier3: [world("w1", 0.7)],
      limit: 3,
      config: cfg,
      now: NOW,
    });
    expect(out.ranked.map((r) => r.candidate.tier).sort()).toEqual(["tier1", "tier2", "tier3"]);
  });

  it("tier-2 V-aware order beats pure cosine when weights favor priority", () => {
    const highCosLowV = trace("t1", 0.95, 0.0); // high sim, worthless
    const highV = trace("t2", 0.4, 0.9); // mediocre sim, high V
    const out = rank({
      tier1: [],
      tier2Traces: [highCosLowV, highV],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: { ...cfg, weightCosine: 0.2, weightPriority: 0.8 },
      now: NOW,
    });
    // t2 should rank ahead of t1 under priority-heavy weights
    const first = out.ranked[0]!.candidate.refId;
    expect(String(first)).toBe("t2");
  });

  it("MMR suppresses near-duplicate vectors", () => {
    const v = [1, 0, 0];
    const a = trace("dup1", 0.9, 0.5, v);
    const b = trace("dup2", 0.89, 0.5, v); // near-identical
    const c = trace("diff", 0.6, 0.5, [0, 1, 0]);
    const out = rank({
      tier1: [],
      tier2Traces: [a, b, c],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: { ...cfg, mmrLambda: 0 }, // pure diversity
      now: NOW,
    });
    const picked = out.ranked.map((r) => String(r.candidate.refId));
    expect(picked).toContain("diff");
  });

  it("respects `limit`", () => {
    const ts = [trace("t1", 0.8, 0.2), trace("t2", 0.7, 0.3), trace("t3", 0.6, 0.4)];
    const out = rank({
      tier1: [],
      tier2Traces: ts,
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: cfg,
      now: NOW,
    });
    expect(out.ranked.length).toBe(2);
  });

  it("tier-3 falls back to cosine-only (no V)", () => {
    const out = rank({
      tier1: [],
      tier2Traces: [],
      tier2Episodes: [episode("ep1", 0.5, 0.9)],
      tier3: [world("w1", 0.4)],
      limit: 5,
      config: cfg,
      now: NOW,
    });
    // Both tiers are seeded; ep1 should outrank w1 due to its high maxValue.
    expect(out.ranked[0]!.candidate.refId).toBe("ep1");
  });

  // ─── Smart-seed + relative threshold (post-overhaul behaviour) ──────────

  it("relative threshold drops candidates below topRelevance · floor", () => {
    const out = rank({
      tier1: [],
      tier2Traces: [
        trace("strong", 0.9, 0.8), // topRelevance ≈ 0.86
        trace("middle", 0.5, 0.4),
        trace("weak", 0.05, 0.0), // ≈ 0.03 → far below floor
      ],
      tier2Episodes: [],
      tier3: [],
      limit: 10,
      config: { ...cfg, relativeThresholdFloor: 0.4 },
      now: NOW,
    });
    const ids = out.ranked.map((r) => String(r.candidate.refId));
    expect(ids).toContain("strong");
    expect(ids).not.toContain("weak");
    expect(out.droppedByThreshold).toBeGreaterThanOrEqual(1);
  });

  it("smart-seed refuses to seed a tier when its best candidate is irrelevant", () => {
    // Tier-1 + Tier-3 only have weak candidates; Tier-2 has a strong
    // signal. With smartSeed=true, the ranker should ship just the
    // tier-2 hit and skip the noisy seeds — the previous behaviour
    // would have force-injected a marginal Tier-1 + Tier-3 each.
    const out = rank({
      tier1: [skill("sk_irrelevant", 0.05, 0.9)],
      tier2Traces: [trace("t_strong", 0.9, 0.8)],
      tier2Episodes: [],
      tier3: [world("w_irrelevant", 0.05)],
      limit: 5,
      config: { ...cfg, relativeThresholdFloor: 0.4, smartSeed: true },
      now: NOW,
    });
    const ids = out.ranked.map((r) => String(r.candidate.refId));
    expect(ids).toContain("t_strong");
    expect(ids).not.toContain("sk_irrelevant");
    expect(ids).not.toContain("w_irrelevant");
  });

  it("smartSeed=false restores legacy behaviour (force-seed every tier)", () => {
    const out = rank({
      tier1: [skill("sk_irrelevant", 0.05, 0.9)],
      tier2Traces: [trace("t_strong", 0.9, 0.8)],
      tier2Episodes: [],
      tier3: [world("w_irrelevant", 0.05)],
      limit: 5,
      config: {
        ...cfg,
        relativeThresholdFloor: 0,
        smartSeed: false,
      },
      now: NOW,
    });
    const ids = out.ranked.map((r) => String(r.candidate.refId));
    expect(ids).toContain("sk_irrelevant");
    expect(ids).toContain("w_irrelevant");
  });

  it("multi-channel hits get an RRF lift over single-channel hits at same cosine", () => {
    const single = trace("single_ch", 0.6, 0.0);
    single.channels = [{ channel: "vec_summary", rank: 0, score: 0.6 }];
    const multi = trace("multi_ch", 0.6, 0.0);
    multi.channels = [
      { channel: "vec_summary", rank: 0, score: 0.6 },
      { channel: "fts", rank: 0, score: 1 / 61 },
      { channel: "pattern", rank: 1, score: 1 / 62 },
    ];
    const out = rank({
      tier1: [],
      tier2Traces: [single, multi],
      tier2Episodes: [],
      tier3: [],
      limit: 5,
      config: { ...cfg, relativeThresholdFloor: 0 },
      now: NOW,
    });
    expect(String(out.ranked[0]!.candidate.refId)).toBe("multi_ch");
  });

  it("skill η no longer dominates cosine — the more-relevant skill wins", () => {
    // Old behaviour blended `0.4·η`, so a high-η stale skill could
    // outrank a fresh, query-aligned one. With the new default
    // `skillEtaBlend=0.15`, cosine dominates.
    const fresh = skill("fresh_match", 0.85, 0.5);
    fresh.channels = [{ channel: "vec", rank: 0, score: 0.85 }];
    const stale = skill("stale_high_eta", 0.2, 0.95);
    stale.channels = [{ channel: "vec", rank: 1, score: 0.2 }];
    const out = rank({
      tier1: [fresh, stale],
      tier2Traces: [],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: { ...cfg, relativeThresholdFloor: 0, skillEtaBlend: 0.15 },
      now: NOW,
    });
    expect(String(out.ranked[0]!.candidate.refId)).toBe("fresh_match");
  });
});
