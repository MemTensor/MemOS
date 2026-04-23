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
  llmFilterEnabled: false,
  llmFilterMaxKeep: 4,
  llmFilterMinCandidates: 1,
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

  it("smart-seed picks every tier when all tier-bests are close to pool top", () => {
    const out = rank({
      tier1: [skill("sk1", 0.9, 0.9)],
      tier2Traces: [trace("t1", 0.85, 0.5)],
      tier2Episodes: [],
      tier3: [world("w1", 0.8)],
      limit: 3,
      config: { ...cfg, relativeThresholdFloor: 0, smartSeedRatio: 0.7 },
      now: NOW,
    });
    expect(out.ranked.map((r) => r.candidate.tier).sort()).toEqual([
      "tier1",
      "tier2",
      "tier3",
    ]);
  });

  it("priority breaks ties within the same base-score band", () => {
    // Same cosine → same base. Higher V adds a priority lift.
    const lowV = trace("t1", 0.5, 0.0);
    const highV = trace("t2", 0.5, 0.9);
    const out = rank({
      tier1: [],
      tier2Traces: [lowV, highV],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: { ...cfg, relativeThresholdFloor: 0 },
      now: NOW,
    });
    expect(String(out.ranked[0]!.candidate.refId)).toBe("t2");
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
      config: { ...cfg, mmrLambda: 0, relativeThresholdFloor: 0 }, // pure diversity
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
      config: { ...cfg, relativeThresholdFloor: 0, smartSeedRatio: 0.3 },
      now: NOW,
    });
    // ep1 has higher base AND a priority lift from maxValue → should lead.
    expect(out.ranked[0]!.candidate.refId).toBe("ep1");
  });

  // ─── Smart-seed + relative threshold (post-overhaul behaviour) ──────────

  it("relative threshold drops candidates below topRelevance · floor", () => {
    const out = rank({
      tier1: [],
      tier2Traces: [
        trace("strong", 0.9, 0.8),
        trace("middle", 0.5, 0.4),
        trace("weak", 0.05, 0.0),
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

  it("smart-seed refuses to seed a tier when its best candidate is far from pool top", () => {
    // Tier-1 + Tier-3 only have weak candidates; Tier-2 has a strong
    // signal. With smartSeedRatio=0.7 AND the relative threshold on,
    // the irrelevant tiers should be cut by threshold — smart-seed is
    // the Phase-A gate, threshold is the pool-wide gate.
    const out = rank({
      tier1: [skill("sk_irrelevant", 0.05, 0.9)],
      tier2Traces: [trace("t_strong", 0.9, 0.8)],
      tier2Episodes: [],
      tier3: [world("w_irrelevant", 0.05)],
      limit: 5,
      config: {
        ...cfg,
        relativeThresholdFloor: 0.4,
        smartSeed: true,
        smartSeedRatio: 0.7,
      },
      now: NOW,
    });
    const ids = out.ranked.map((r) => String(r.candidate.refId));
    expect(ids).toContain("t_strong");
    expect(ids).not.toContain("sk_irrelevant");
    expect(ids).not.toContain("w_irrelevant");
  });

  it("smart-seed blocks Phase-A tier seeding even when threshold is disabled", () => {
    // When threshold=0 the pool keeps everyone, but Phase-A must still
    // skip seeding weak tiers. We verify t_strong is seeded first
    // (proving Phase-A ran) and that sk_irrelevant / w_irrelevant can
    // only appear via Phase-B MMR, not as forced tier seeds.
    const out = rank({
      tier1: [skill("sk_irrelevant", 0.05, 0.9)],
      tier2Traces: [trace("t_strong", 0.9, 0.8)],
      tier2Episodes: [],
      tier3: [world("w_irrelevant", 0.05)],
      limit: 1,
      config: {
        ...cfg,
        relativeThresholdFloor: 0,
        smartSeed: true,
        smartSeedRatio: 0.7,
      },
      now: NOW,
    });
    expect(out.ranked.length).toBe(1);
    expect(String(out.ranked[0]!.candidate.refId)).toBe("t_strong");
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

  it("multi-channel hits get an RRF lift over single-channel hits at same base", () => {
    const single = trace("single_ch", 0.6, 0.0);
    single.channels = [{ channel: "vec_summary", rank: 0, score: 0.6 }];
    const multi = trace("multi_ch", 0.6, 0.0);
    multi.channels = [
      { channel: "vec_summary", rank: 0, score: 0.6 },
      { channel: "fts", rank: 0, score: 1 },
      { channel: "pattern", rank: 1, score: 0.5 },
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

  it("multi-channel bypass lets low-relevance keyword hits survive threshold", () => {
    // Strong candidate pulls topRelevance up; keyword-only single-channel
    // hit would be guillotined by the relative floor, BUT a multi-channel
    // hit with the same base should survive via the bypass.
    const strong = trace("strong", 0.9, 0.9);
    strong.channels = [{ channel: "vec_summary", rank: 0, score: 0.9 }];
    const ftsOnly = trace("fts_only", 0.1, 0.0);
    ftsOnly.channels = [{ channel: "fts", rank: 3, score: 0.25 }];
    const confirmed = trace("confirmed", 0.12, 0.0);
    confirmed.channels = [
      { channel: "fts", rank: 3, score: 0.25 },
      { channel: "pattern", rank: 2, score: 0.33 },
    ];
    const out = rank({
      tier1: [],
      tier2Traces: [strong, ftsOnly, confirmed],
      tier2Episodes: [],
      tier3: [],
      limit: 5,
      config: { ...cfg, relativeThresholdFloor: 0.4, multiChannelBypass: true },
      now: NOW,
    });
    const ids = out.ranked.map((r) => String(r.candidate.refId));
    expect(ids).toContain("strong");
    expect(ids).toContain("confirmed");
    // The single-channel weak FTS hit should still get cut.
    expect(ids).not.toContain("fts_only");
  });

  it("multiChannelBypass=false restores strict threshold for multi-channel hits", () => {
    const strong = trace("strong", 0.9, 0.9);
    strong.channels = [{ channel: "vec_summary", rank: 0, score: 0.9 }];
    const confirmed = trace("confirmed", 0.12, 0.0);
    confirmed.channels = [
      { channel: "fts", rank: 3, score: 0.25 },
      { channel: "pattern", rank: 2, score: 0.33 },
    ];
    const out = rank({
      tier1: [],
      tier2Traces: [strong, confirmed],
      tier2Episodes: [],
      tier3: [],
      limit: 5,
      config: { ...cfg, relativeThresholdFloor: 0.5, multiChannelBypass: false },
      now: NOW,
    });
    const ids = out.ranked.map((r) => String(r.candidate.refId));
    expect(ids).toContain("strong");
    expect(ids).not.toContain("confirmed");
  });

  it("skill η no longer dominates cosine — the more-relevant skill wins", () => {
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

  it("tallies channel hits for observability", () => {
    const a = trace("a", 0.8, 0.5);
    a.channels = [
      { channel: "vec_summary", rank: 0, score: 0.8 },
      { channel: "fts", rank: 1, score: 0.5 },
    ];
    const b = trace("b", 0.6, 0.5);
    b.channels = [{ channel: "pattern", rank: 0, score: 0.9 }];
    const out = rank({
      tier1: [],
      tier2Traces: [a, b],
      tier2Episodes: [],
      tier3: [],
      limit: 5,
      config: { ...cfg, relativeThresholdFloor: 0 },
      now: NOW,
    });
    expect(out.channelHits.vec_summary).toBe(1);
    expect(out.channelHits.fts).toBe(1);
    expect(out.channelHits.pattern).toBe(1);
    expect(out.topRelevance).toBeGreaterThan(0);
    expect(out.thresholdFloor).toBe(0);
  });
});
