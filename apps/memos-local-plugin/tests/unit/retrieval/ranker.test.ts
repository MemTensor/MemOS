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
    userText: `user ${id}`,
    agentText: `agent ${id}`,
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

  it("hard-dedupes repeated-question chatter before MMR so Top-K is refilled", () => {
    const question = "我最喜欢的水果是什么？";
    const ackHigh = trace("ack_high", 0.99, 0, [1, 0]);
    const ackSecond = trace("ack_second", 0.98, 0, [1, 0]);
    const answer = trace("answer", 0.95, 0, [1, 0]);
    const other = trace("other", 0.7, 0, [0, 1]);
    Object.assign(ackHigh, { userText: question, agentText: "好的" });
    Object.assign(ackSecond, { userText: ` ${question}！`, agentText: "收到" });
    Object.assign(answer, {
      userText: question,
      agentText: "你之前明确说过，自己最喜欢的水果一直都是芒果。",
    });
    Object.assign(other, {
      userText: "我最喜欢的歌手是谁？",
      agentText: "你之前提到过，自己最喜欢的歌手一直都是陈奕迅。",
    });

    const out = rank({
      tier1: [],
      tier2Traces: [ackHigh, ackSecond, answer, other],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      profile: "personal_fact",
      config: {
        ...cfg,
        relativeThresholdFloor: 0,
        smartSeed: false,
      },
      now: NOW,
    });

    expect(out.ranked.map((item) => String(item.candidate.refId))).toEqual([
      "answer",
      "other",
    ]);
    expect(out.dedupedBeforeMmr).toBe(2);
  });

  it("dedupes before recomputing the relative threshold so chatter cannot raise the floor", () => {
    const question = "我最喜欢的水果是什么？";
    const highChatter = trace("high_chatter", 0.99, 0);
    const answer = trace("answer", 0.75, 0);
    const other = trace("other", 0.74, 0);
    Object.assign(highChatter, {
      userText: question,
      agentText: "好的",
    });
    Object.assign(answer, {
      userText: question,
      agentText: "你之前明确说过，自己最喜欢的水果一直都是芒果。",
    });
    Object.assign(other, {
      userText: "我最喜欢的歌手是谁？",
      agentText: "你之前提到过，自己最喜欢的歌手一直都是陈奕迅。",
    });

    const out = rank({
      tier1: [],
      tier2Traces: [highChatter, answer, other],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: {
        ...cfg,
        relativeThresholdFloor: 0.8,
        smartSeed: false,
      },
      now: NOW,
    });

    expect(out.ranked.map((item) => String(item.candidate.refId))).toEqual([
      "answer",
      "other",
    ]);
    expect(out.dedupedBeforeMmr).toBe(1);
    expect(out.topRelevance).toBeCloseTo(0.75, 5);
    expect(out.thresholdFloor).toBeCloseTo(0.6, 5);
  });

  it("uses post-score relevance to choose an exact-summary duplicate before MMR", () => {
    const question = "我最喜欢的水果是什么？";
    const lower = trace("lower", 0.89, 0);
    const higher = trace("higher", 0.9, 0);
    const other = trace("other", 0.7, 0);
    Object.assign(lower, {
      userText: question,
      agentText: "好的",
      summary: "用户最喜欢的水果是芒果",
    });
    Object.assign(higher, {
      userText: `${question}！`,
      agentText: "收到",
      summary: "用户最喜欢的水果是芒果",
    });

    const out = rank({
      tier1: [],
      tier2Traces: [lower, higher, other],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: {
        ...cfg,
        relativeThresholdFloor: 0,
        smartSeed: false,
      },
      now: NOW,
    });

    expect(out.ranked.map((item) => String(item.candidate.refId))).toEqual([
      "higher",
      "other",
    ]);
    expect(out.dedupedBeforeMmr).toBe(1);
  });

  it("rejects a generic pattern impostor and keeps the candidate containing the exact identifier", () => {
    const identifier = "project_id_2026_alpha_001";
    const patternImpostor = trace("pattern_impostor", 0.9, 0);
    const exactMatch = trace("exact_match", 0.8, 0);
    Object.assign(patternImpostor, {
      userText: "请查询之前的普通项目记录",
      agentText: "好的",
      summary: "项目状态为已完成",
      channels: [
        { channel: "vec_summary", rank: 0, score: 0.9 },
        { channel: "pattern", rank: 0, score: 1 },
      ],
    });
    Object.assign(exactMatch, {
      userText: `项目 ${identifier} 的状态`,
      agentText: "收到",
      summary: "项目状态为已完成",
      channels: [{ channel: "exact_identifier", rank: 0, score: 1 }],
    });

    const out = rank({
      tier1: [],
      tier2Traces: [patternImpostor, exactMatch],
      tier2Episodes: [],
      tier3: [],
      limit: 1,
      exactIdentifiers: [identifier],
      config: {
        ...cfg,
        relativeThresholdFloor: 0,
        smartSeed: false,
      },
      now: NOW,
    });

    expect(out.ranked.map((item) => String(item.candidate.refId))).toEqual([
      "exact_match",
    ]);
    expect(out.droppedByKeywordConfirmation).toBe(1);
  });

  it("does not let a higher single-channel duplicate erase a lower multi-channel bypass candidate", () => {
    const question = "我最喜欢的水果是什么？";
    const top = trace("top", 1, 0);
    const ordinary = trace("ordinary", 0.58, 0);
    const bypass = trace("bypass", 0.55, 0);
    Object.assign(top, {
      channels: [{ channel: "vec_summary", rank: 0, score: 1 }],
    });
    Object.assign(ordinary, {
      userText: question,
      agentText: "好的",
      summary: "用户最喜欢的水果是芒果",
      channels: [{ channel: "vec_summary", rank: 1, score: 0.58 }],
    });
    Object.assign(bypass, {
      userText: question,
      agentText: "收到",
      summary: "用户最喜欢的水果是芒果",
      channels: [
        { channel: "vec_summary", rank: 5, score: 0.55 },
        { channel: "pattern", rank: 4, score: 0.2 },
      ],
    });

    const out = rank({
      tier1: [],
      tier2Traces: [top, ordinary, bypass],
      tier2Episodes: [],
      tier3: [],
      limit: 3,
      config: {
        ...cfg,
        relativeThresholdFloor: 0.6,
        multiChannelBypass: true,
        smartSeed: false,
      },
      now: NOW,
    });

    const ids = out.ranked.map((item) => String(item.candidate.refId));
    expect(ids).toContain("top");
    expect(ids).toContain("bypass");
    expect(ids).not.toContain("ordinary");
    expect(out.ranked.find((item) => item.candidate.refId === bypass.refId))
      .toMatchObject({ bypassedThreshold: true });
  });

  it("collapses capability variants again after both duplicates survive the threshold", () => {
    const question = "我最喜欢的水果是什么？";
    const ordinary = trace("ordinary", 0.8, 0);
    const bypassCapable = trace("bypass_capable", 0.75, 0);
    Object.assign(ordinary, {
      userText: question,
      agentText: "好的",
      summary: "用户最喜欢的水果是芒果",
      channels: [{ channel: "vec_summary", rank: 0, score: 0.8 }],
    });
    Object.assign(bypassCapable, {
      userText: question,
      agentText: "收到",
      summary: "用户最喜欢的水果是芒果",
      channels: [
        { channel: "vec_summary", rank: 1, score: 0.75 },
        { channel: "pattern", rank: 0, score: 0.2 },
      ],
    });

    const out = rank({
      tier1: [],
      tier2Traces: [ordinary, bypassCapable],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: {
        ...cfg,
        relativeThresholdFloor: 0.4,
        multiChannelBypass: true,
        smartSeed: false,
      },
      now: NOW,
    });

    expect(out.ranked.map((item) => String(item.candidate.refId))).toEqual([
      "ordinary",
    ]);
    expect(out.dedupedBeforeMmr).toBe(1);
    expect(out.dedupedAfterThreshold).toBe(1);
  });

  it("keeps different concise fact answers to the same question", () => {
    const question = "我最喜欢的水果是什么？";
    const oldAnswer = trace("old_short", 0.9, 0);
    const newAnswer = trace("new_short", 0.85, 0);
    Object.assign(oldAnswer, {
      userText: question,
      agentText: "苹果",
    });
    Object.assign(newAnswer, {
      userText: question,
      agentText: "芒果",
    });

    const out = rank({
      tier1: [],
      tier2Traces: [oldAnswer, newAnswer],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: {
        ...cfg,
        relativeThresholdFloor: 0,
        smartSeed: false,
      },
      now: NOW,
    });

    expect(out.ranked.map((item) => String(item.candidate.refId))).toEqual([
      "old_short",
      "new_short",
    ]);
    expect(out.dedupedBeforeMmr).toBe(0);
  });

  it("preserves semantic symbols when grouping repeated questions", () => {
    const cpp = trace("cpp", 0.9, 0);
    const c = trace("c", 0.85, 0);
    Object.assign(cpp, {
      userText: "C++ 怎么学？",
      agentText: "好的",
    });
    Object.assign(c, {
      userText: "C 怎么学？",
      agentText: "收到",
    });

    const out = rank({
      tier1: [],
      tier2Traces: [cpp, c],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: {
        ...cfg,
        relativeThresholdFloor: 0,
        smartSeed: false,
      },
      now: NOW,
    });

    expect(out.ranked.map((item) => String(item.candidate.refId))).toEqual([
      "cpp",
      "c",
    ]);
    expect(out.dedupedBeforeMmr).toBe(0);
  });

  it("keeps a summary-only fact alongside a different substantive answer", () => {
    const question = "我最喜欢的水果是什么？";
    const summaryOnly = trace("summary_only", 0.9, 0);
    const answer = trace("answer", 0.85, 0);
    Object.assign(summaryOnly, {
      userText: question,
      agentText: "好的",
      summary: "用户曾经最喜欢的水果是苹果",
    });
    Object.assign(answer, {
      userText: question,
      agentText: "你后来更新了偏好，现在自己最喜欢的水果已经变成芒果。",
    });

    const out = rank({
      tier1: [],
      tier2Traces: [summaryOnly, answer],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: {
        ...cfg,
        relativeThresholdFloor: 0,
        smartSeed: false,
      },
      now: NOW,
    });

    expect(out.ranked.map((item) => String(item.candidate.refId))).toEqual([
      "summary_only",
      "answer",
    ]);
    expect(out.dedupedBeforeMmr).toBe(0);
  });

  it("keeps distinct substantive answers to the same question before MMR", () => {
    const question = "我最喜欢的水果是什么？";
    const oldAnswer = trace("old", 0.9, 0);
    const newAnswer = trace("new", 0.85, 0);
    Object.assign(oldAnswer, {
      userText: question,
      agentText: "你以前明确说过，当时自己最喜欢的水果一直都是苹果。",
    });
    Object.assign(newAnswer, {
      userText: question,
      agentText: "你后来更新了偏好，现在自己最喜欢的水果已经变成芒果。",
    });

    const out = rank({
      tier1: [],
      tier2Traces: [oldAnswer, newAnswer],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: {
        ...cfg,
        relativeThresholdFloor: 0,
        smartSeed: false,
      },
      now: NOW,
    });

    expect(out.ranked.map((item) => String(item.candidate.refId))).toEqual([
      "old",
      "new",
    ]);
    expect(out.dedupedBeforeMmr).toBe(0);
  });

  it("keeps mixed-dimension candidates without crashing MMR", () => {
    const out = rank({
      tier1: [],
      tier2Traces: [
        trace("current_dim", 0.9, 0.5, [1, 0, 0]),
        trace("legacy_dim", 0.8, 0.5, [1, 0]),
      ],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: { ...cfg, relativeThresholdFloor: 0 },
      now: NOW,
    });

    expect(out.ranked.map((r) => String(r.candidate.refId))).toEqual([
      "current_dim",
      "legacy_dim",
    ]);
    expect(out.ranked[1]!.scoreDetails?.redundancy).toBe(0);
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

  it("scores Phase-A seeds on the same MMR scale as Phase-B picks", () => {
    const out = rank({
      tier1: [skill("seed_skill", 0.75, 0)],
      tier2Traces: [
        trace("top_trace", 1.0, 0),
        trace("second_trace", 0.95, 0),
      ],
      tier2Episodes: [],
      tier3: [],
      limit: 3,
      config: {
        ...cfg,
        relativeThresholdFloor: 0,
        skillEtaBlend: 0,
        smartSeed: true,
        smartSeedRatio: 0.7,
      },
      now: NOW,
    });

    const ids = out.ranked.map((r) => String(r.candidate.refId));
    expect(ids.indexOf("second_trace")).toBeLessThan(ids.indexOf("seed_skill"));
  });

  it("uses MMR, not raw relevance, when choosing a Phase-A seed within a tier", () => {
    const out = rank({
      tier1: [skill("seed_skill", 1.0, 0, [1, 0])],
      tier2Traces: [
        trace("duplicate_trace", 0.95, 0, [1, 0]),
        trace("diverse_trace", 0.8, 0, [0, 1]),
      ],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: {
        ...cfg,
        mmrLambda: 0.5,
        relativeThresholdFloor: 0,
        smartSeed: true,
        smartSeedRatio: 0.7,
      },
      now: NOW,
    });

    const ids = out.ranked.map((r) => String(r.candidate.refId));
    expect(ids).toContain("diverse_trace");
    expect(ids).not.toContain("duplicate_trace");
  });

  it("anchors the first MMR pick by relevance when lambda is zero", () => {
    const out = rank({
      tier1: [],
      tier2Traces: [
        trace("weak_first", 0.1, 0),
        trace("strong_second", 1.0, 0),
      ],
      tier2Episodes: [],
      tier3: [],
      limit: 1,
      config: {
        ...cfg,
        mmrLambda: 0,
        relativeThresholdFloor: 0,
        smartSeed: true,
        smartSeedRatio: 0,
      },
      now: NOW,
    });

    expect(String(out.ranked[0]!.candidate.refId)).toBe("strong_second");
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

  it("does not let two weak keyword channels bypass the threshold", () => {
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
    expect(ids).not.toContain("confirmed");
    // The single-channel weak FTS hit should still get cut.
    expect(ids).not.toContain("fts_only");
  });

  it("lets a multi-channel hit with strong semantic evidence bypass the threshold", () => {
    const strong = trace("strong", 1, 0);
    strong.channels = [{ channel: "vec_summary", rank: 0, score: 1 }];
    const confirmed = trace("confirmed", 0.5, 0);
    confirmed.channels = [
      { channel: "vec_summary", rank: 5, score: 0.5 },
      { channel: "pattern", rank: 4, score: 0.2 },
    ];

    const out = rank({
      tier1: [],
      tier2Traces: [strong, confirmed],
      tier2Episodes: [],
      tier3: [],
      limit: 5,
      config: { ...cfg, relativeThresholdFloor: 0.6, multiChannelBypass: true },
      now: NOW,
    });

    expect(out.ranked.map((item) => String(item.candidate.refId))).toContain("confirmed");
  });

  it("uses relevance-focused MMR and ignores V for personal facts", () => {
    const first = trace("first", 1, 0, [1, 0]);
    const duplicate = trace("duplicate", 0.89, 0, [1, 0]);
    const diverseHighV = trace("diverse", 0.6, 1, [0, 1]);

    const out = rank({
      tier1: [],
      tier2Traces: [first, duplicate, diverseHighV],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      profile: "personal_fact",
      config: { ...cfg, mmrLambda: 0, relativeThresholdFloor: 0 },
      now: NOW,
    });

    expect(out.ranked.map((item) => String(item.candidate.refId))).toEqual([
      "first",
      "duplicate",
    ]);
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
