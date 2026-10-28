import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runTier2 } from "../../../core/retrieval/tier2-trace.js";
import type { RetrievalConfig } from "../../../core/retrieval/types.js";
import type { EmbeddingVector, EpisodeId, SessionId, TraceId } from "../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

const NOW = 1_700_000_000_000;

function vec(arr: number[]): EmbeddingVector {
  return Float32Array.from(arr) as unknown as EmbeddingVector;
}

const cfg: RetrievalConfig = {
  tier1TopK: 3,
  tier2TopK: 3,
  tier3TopK: 2,
  candidatePoolFactor: 4,
  weightCosine: 0.5,
  weightPriority: 0.5,
  mmrLambda: 0.7,
  includeLowValue: false,
  rrfConstant: 60,
  minSkillEta: 0.5,
  minTraceSim: 0.3,
  tagFilter: "auto",
  decayHalfLifeDays: 30,
  llmFilterEnabled: false,
  llmFilterMaxKeep: 4,
  llmFilterMinCandidates: 1,
};

function seed(handle: TmpDbHandle) {
  handle.repos.sessions.upsert({
    id: "s1" as SessionId,
    agent: "openclaw",
    startedAt: NOW,
    lastSeenAt: NOW,
    meta: {},
  });
  handle.repos.episodes.upsert({
    id: "ep1" as EpisodeId,
    sessionId: "s1" as SessionId,
    startedAt: NOW as never,
    endedAt: null,
    traceIds: [],
    rTask: null,
    status: "open",
  });

  const insertTrace = (
    id: string,
    value: number,
    priority: number,
    v: number[],
    tags: string[],
  ) => {
    handle.repos.traces.insert({
      id: id as TraceId,
      episodeId: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      ts: (NOW - 3600_000) as never,
      userText: `${id} query about docker`,
      agentText: `${id} response`,
      toolCalls: [],
      reflection: `${id} reflection`,
      value: value as never,
      alpha: 0.5 as never,
      rHuman: null,
      priority: priority as never,
      tags,
      vecSummary: vec(v),
      vecAction: null,
      turnId: 0 as never,
      schemaVersion: 1,
    });
  };

  insertTrace("hiV", 0.9, 0.9, [1, 0, 0], ["docker"]);
  insertTrace("medV", 0.3, 0.3, [0.9, 0.1, 0], ["docker"]);
  insertTrace("zeroV", 0.0, 0.0, [0.8, 0.2, 0], ["docker"]); // priority=0 → hidden
  insertTrace("pipRow", 0.5, 0.5, [0.8, 0.6, 0], ["pip"]); // on-axis enough to survive cosine
  insertTrace("offTopic", 0.5, 0.5, [0, 1, 0], ["unrelated"]);
}

describe("retrieval/tier2 (with real sqlite)", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb({ agent: "openclaw" });
    seed(handle);
  });
  afterEach(() => handle.cleanup());

  it("returns top traces by blended score, hides zero-priority by default", async () => {
    const out = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      { queryVec: vec([1, 0, 0]), tags: ["docker"] },
    );
    const ids = out.traces.map((t) => String(t.refId));
    expect(ids).toContain("hiV");
    expect(ids).not.toContain("zeroV");
  });

  it("returns the expanded candidate pool instead of truncating before global ranking", async () => {
    const out = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      { queryVec: vec([1, 0, 0]), tags: [], includeLowValue: true },
    );

    expect(out.traces.length).toBeGreaterThan(cfg.tier2TopK);
  });

  it("does not add value priority during Tier-2 pre-ordering", async () => {
    handle.repos.traces.insert({
      id: "semanticFirst" as TraceId,
      episodeId: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      ts: NOW as never,
      userText: "semantic match",
      agentText: "reply",
      toolCalls: [],
      reflection: null,
      value: 0.05 as never,
      alpha: 0.5 as never,
      rHuman: null,
      priority: 0.05 as never,
      tags: [],
      vecSummary: vec([1, 0, 0]),
      vecAction: null,
      turnId: 0 as never,
      schemaVersion: 1,
    });
    handle.repos.traces.insert({
      id: "valuableButWeaker" as TraceId,
      episodeId: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      ts: NOW as never,
      userText: "weaker match",
      agentText: "reply",
      toolCalls: [],
      reflection: null,
      value: 1 as never,
      alpha: 0.5 as never,
      rHuman: null,
      priority: 1 as never,
      tags: [],
      vecSummary: vec([0.8, 0.6, 0]),
      vecAction: null,
      turnId: 0 as never,
      schemaVersion: 1,
    });

    const out = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      { queryVec: vec([1, 0, 0]), tags: [] },
    );

    const ids = out.traces.map((trace) => String(trace.refId));
    expect(ids.indexOf("semanticFirst")).toBeLessThan(ids.indexOf("valuableButWeaker"));
  });

  it("uses summary vectors only for the personal-fact first pass", async () => {
    handle.repos.traces.insert({
      id: "actionOnly" as TraceId,
      episodeId: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      ts: NOW as never,
      userText: "action-only match",
      agentText: "reply",
      toolCalls: [],
      reflection: null,
      value: 0.8 as never,
      alpha: 0.5 as never,
      rHuman: null,
      priority: 0.8 as never,
      tags: [],
      vecSummary: vec([0, 1, 0]),
      vecAction: vec([1, 0, 0]),
      turnId: 0 as never,
      schemaVersion: 1,
    });

    const out = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      { queryVec: vec([1, 0, 0]), tags: [], profile: "personal_fact" },
    );
    const actionOnly = out.traces.find((trace) => trace.refId === "actionOnly");

    expect(
      actionOnly?.channels?.some((channel) => channel.channel === "vec_action") ?? false,
    ).toBe(false);
  });

  it("drops vector hits below the adaptive semantic floor", async () => {
    const out = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      { queryVec: vec([1, 0, 0]), tags: [] },
    );

    expect(out.traces.map((trace) => String(trace.refId))).not.toContain("offTopic");
  });

  it("hydrates each candidate with its stored vector instead of the query vector", async () => {
    const queryVec = vec([1, 0, 0]);
    const out = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      { queryVec, tags: ["docker"] },
    );
    const candidate = out.traces.find((trace) => String(trace.refId) === "medV");

    expect(Array.from(candidate!.vec!)).toEqual(
      expect.arrayContaining([expect.closeTo(0.9), expect.closeTo(0.1), 0]),
    );
    expect(candidate!.vec).not.toBe(queryVec);
  });

  it("recalls a full identifier through a dedicated channel instead of generic pattern terms", async () => {
    const identifier = "project_id_2026_alpha_001";
    handle.repos.traces.insert({
      id: "exactIdentifier" as TraceId,
      episodeId: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      ts: NOW as never,
      userText: `项目 ${identifier} 已经完成`,
      agentText: "状态已确认",
      toolCalls: [],
      reflection: null,
      value: 0.8 as never,
      alpha: 0.5 as never,
      rHuman: null,
      priority: 0.8 as never,
      tags: [],
      vecSummary: vec([0, 1, 0]),
      vecAction: null,
      turnId: 0 as never,
      schemaVersion: 1,
    });
    handle.repos.traces.insert({
      id: "genericPattern" as TraceId,
      episodeId: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      ts: NOW as never,
      userText: "请查询之前的普通项目记录",
      agentText: "状态已确认",
      toolCalls: [],
      reflection: null,
      value: 0.8 as never,
      alpha: 0.5 as never,
      rHuman: null,
      priority: 0.8 as never,
      tags: [],
      vecSummary: vec([0, 1, 0]),
      vecAction: null,
      turnId: 0 as never,
      schemaVersion: 1,
    });

    const out = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      {
        queryVec: null,
        tags: [],
        patternTerms: ["查询"],
        exactIdentifiers: [identifier],
      },
    );

    const exact = out.traces.find((candidate) =>
      String(candidate.refId) === "exactIdentifier"
    );
    expect(exact?.channels).toContainEqual(
      expect.objectContaining({ channel: "exact_identifier" }),
    );
    expect(
      out.traces.find((candidate) => String(candidate.refId) === "genericPattern")
        ?.channels,
    ).toContainEqual(expect.objectContaining({ channel: "pattern" }));
  });

  it("tag filter narrows candidate set", async () => {
    const out = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      { queryVec: vec([1, 0, 0]), tags: ["pip"] },
    );
    // only offTopic has "pip"; it's orthogonal to query vec, so cosine low
    expect(out.traces.every((t) => t.tags.includes("pip"))).toBe(true);
  });

  it("falls back past tag filter in auto mode when empty", async () => {
    const out = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      { queryVec: vec([1, 0, 0]), tags: ["nonexistent-tag"] },
    );
    expect(out.traces.length).toBeGreaterThan(0);
  });

  it("includeLowValue brings back priority=0 traces", async () => {
    const out = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      { queryVec: vec([1, 0, 0]), tags: ["docker"], includeLowValue: true },
    );
    const ids = out.traces.map((t) => String(t.refId));
    expect(ids).toContain("zeroV");
  });

  it("excludes only the visible window of the current session", async () => {
    handle.repos.sessions.upsert({
      id: "s2" as SessionId,
      agent: "openclaw",
      startedAt: NOW,
      lastSeenAt: NOW,
      meta: {},
    });
    handle.repos.episodes.upsert({
      id: "ep2" as EpisodeId,
      sessionId: "s2" as SessionId,
      startedAt: NOW as never,
      endedAt: null,
      traceIds: [],
      rTask: null,
      status: "open",
    });
    handle.repos.traces.insert({
      id: "compactedSameSession" as TraceId,
      episodeId: "ep2" as EpisodeId,
      sessionId: "s2" as SessionId,
      ts: (NOW - 10_000) as never,
      userText: "compacted same session docker query",
      agentText: "reply",
      toolCalls: [],
      reflection: "ref",
      value: 0.95 as never,
      alpha: 0.5 as never,
      rHuman: null,
      priority: 0.95 as never,
      tags: ["docker"],
      vecSummary: vec([1, 0, 0]),
      vecAction: null,
      turnId: 0 as never,
      schemaVersion: 1,
    });
    handle.repos.traces.insert({
      id: "visibleSameSession" as TraceId,
      episodeId: "ep2" as EpisodeId,
      sessionId: "s2" as SessionId,
      ts: NOW as never,
      userText: "visible same session docker query",
      agentText: "reply",
      toolCalls: [],
      reflection: "ref",
      value: 0.95 as never,
      alpha: 0.5 as never,
      rHuman: null,
      priority: 0.95 as never,
      tags: ["docker"],
      vecSummary: vec([1, 0, 0]),
      vecAction: null,
      turnId: 1 as never,
      schemaVersion: 1,
    });

    const withoutWindow = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      { queryVec: vec([1, 0, 0]), tags: ["docker"] },
    );
    expect(withoutWindow.traces.map((t) => String(t.refId))).toEqual(
      expect.arrayContaining(["compactedSameSession", "visibleSameSession"]),
    );

    const withWindow = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      {
        queryVec: vec([1, 0, 0]),
        tags: ["docker"],
        visibleContext: {
          sessionId: "s2" as SessionId,
          startTs: NOW - 5_000,
          userTexts: ["visible same session docker query"],
        },
      },
    );
    const ids = withWindow.traces.map((t) => String(t.refId));
    expect(ids).toContain("compactedSameSession");
    expect(ids).not.toContain("visibleSameSession");
  });

  it("falls back to exact visible-user-text filtering when timestamps are unavailable", async () => {
    const out = await runTier2(
      { repos: { traces: handle.repos.traces }, config: cfg, now: () => NOW },
      {
        queryVec: vec([1, 0, 0]),
        tags: ["docker"],
        visibleContext: {
          sessionId: "s1" as SessionId,
          userTexts: ["hiV query about docker"],
        },
      },
    );
    expect(out.traces.map((t) => String(t.refId))).not.toContain("hiV");
  });

  it("rolls up episodes when ≥2 traces share episode_id", async () => {
    const out = await runTier2(
      {
        repos: { traces: handle.repos.traces },
        config: { ...cfg, tier2TopK: 5 },
        now: () => NOW,
      },
      { queryVec: vec([1, 0, 0]), tags: [] },
    );
    if (out.traces.length >= 2) {
      expect(out.episodes.length).toBeGreaterThanOrEqual(1);
      expect(out.episodes[0]!.summary).toContain("Past similar episode");
      expect(out.episodes[0]!.summary).not.toMatch(/best V|goal-sim|V=/);
    }
  });
});
