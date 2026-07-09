import { describe, expect, it } from "vitest";

import { dedupeTraceEpisodeByEpisodeId } from "../../../core/retrieval/dedupe-trace-episode.js";
import type { RankedCandidate } from "../../../core/retrieval/ranker.js";
import type { EpisodeCandidate, TraceCandidate } from "../../../core/retrieval/types.js";

const NOW = 1_700_000_000_000 as never;

function rc<C extends { tier: string }>(
  c: C,
  score: number,
  relevance = score,
): RankedCandidate {
  return {
    candidate: c as unknown as RankedCandidate["candidate"],
    relevance,
    rrf: 0.01,
    score,
    normSq: null,
  };
}

function trace(id: string, episodeId: string, score: number): RankedCandidate {
  return rc<TraceCandidate>(
    {
      tier: "tier2",
      refKind: "trace",
      refId: id as never,
      cosine: score,
      ts: NOW,
      vec: null,
      value: 0.8 as never,
      priority: 0.8,
      episodeId: episodeId as never,
      sessionId: "s_other" as never,
      vecKind: "summary",
      userText: "u",
      agentText: "a",
      summary: "summary",
      reflection: null,
      tags: [],
    },
    score,
  );
}

function episode(id: string, score: number): RankedCandidate {
  return rc<EpisodeCandidate>(
    {
      tier: "tier2",
      refKind: "episode",
      refId: id as never,
      cosine: score,
      ts: NOW,
      vec: null,
      sessionId: "s_other" as never,
      summary: "rollup",
      maxValue: 0.9 as never,
      meanPriority: 0.5,
    },
    score,
  );
}

describe("dedupeTraceEpisodeByEpisodeId", () => {
  it("keeps only the higher-scored row when trace and episode share episodeId", () => {
    const ranked = [trace("t1", "ep_shared", 0.9), episode("ep_shared", 0.7)];
    const { ranked: kept, dedupedByEpisodeCount } = dedupeTraceEpisodeByEpisodeId(ranked);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.candidate.refKind).toBe("trace");
    expect(dedupedByEpisodeCount).toBe(1);
  });

  it("keeps all trace rows from the same episode when no episode rollup is present", () => {
    const ranked = [trace("t1", "ep_shared", 0.9), trace("t2", "ep_shared", 0.7)];
    const { ranked: kept, dedupedByEpisodeCount } = dedupeTraceEpisodeByEpisodeId(ranked);
    expect(kept).toHaveLength(2);
    expect(kept.map((r) => String(r.candidate.refId))).toEqual(["t1", "t2"]);
    expect(dedupedByEpisodeCount).toBe(0);
  });

  it("keeps all traces and drops the episode when the trace side wins", () => {
    const ranked = [
      trace("t1", "ep_shared", 0.9),
      trace("t2", "ep_shared", 0.7),
      episode("ep_shared", 0.6),
    ];
    const { ranked: kept, dedupedByEpisodeCount } = dedupeTraceEpisodeByEpisodeId(ranked);
    expect(kept.map((r) => String(r.candidate.refId))).toEqual(["t1", "t2"]);
    expect(dedupedByEpisodeCount).toBe(1);
  });

  it("keeps only the best episode when the episode side wins", () => {
    const ranked = [
      trace("t1", "ep_shared", 0.7),
      trace("t2", "ep_shared", 0.6),
      episode("ep_shared", 0.9),
    ];
    const { ranked: kept, dedupedByEpisodeCount } = dedupeTraceEpisodeByEpisodeId(ranked);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.candidate.refKind).toBe("episode");
    expect(dedupedByEpisodeCount).toBe(2);
  });

  it("prefers episode on score tie", () => {
    const ranked = [trace("t1", "ep_shared", 0.8), episode("ep_shared", 0.8)];
    const { ranked: kept } = dedupeTraceEpisodeByEpisodeId(ranked);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.candidate.refKind).toBe("episode");
  });

  it("leaves unrelated ref kinds untouched", () => {
    const ranked = [
      trace("t1", "ep_a", 0.9),
      episode("ep_b", 0.8),
    ];
    const { ranked: kept, dedupedByEpisodeCount } = dedupeTraceEpisodeByEpisodeId(ranked);
    expect(kept).toHaveLength(2);
    expect(dedupedByEpisodeCount).toBe(0);
  });
});
