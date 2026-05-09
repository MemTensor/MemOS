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
      expect(out.episodes[0]!.summary).toContain("episode");
    }
  });
});
