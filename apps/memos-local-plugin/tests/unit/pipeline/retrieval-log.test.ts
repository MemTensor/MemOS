import { describe, expect, it } from "vitest";

import type { InjectionSnippet } from "../../../agent-contract/dto.js";
import { buildLocalRetrievalLogStages } from "../../../core/pipeline/retrieval-log.js";

function snippet(refId: string, score: number): InjectionSnippet {
  return {
    refKind: "trace",
    refId,
    body: `memory ${refId}`,
    score,
  };
}

describe("pipeline/retrieval-log", () => {
  it("reconstructs the pre-LLM candidates from kept and dropped snippets", () => {
    // The LLM is allowed to rerank kept candidates independently of the
    // mechanical score. The initial funnel must recover score order without
    // changing the actual post-LLM injection order or losing dropped rows.
    const kept = [snippet("kept-direct-answer", 0.21), snippet("kept-top-score", 1.013)];
    const dropped = [snippet("dropped-middle", 0.4)];

    const stages = buildLocalRetrievalLogStages({
      snippets: kept,
      droppedByLlm: dropped,
    });

    expect(stages.candidates).toHaveLength(kept.length + dropped.length);
    expect(stages.candidates.map((candidate) => candidate.refId)).toEqual([
      "kept-top-score",
      "dropped-middle",
      "kept-direct-answer",
    ]);
    expect(stages.filtered.map((candidate) => candidate.refId)).toEqual([
      "kept-direct-answer",
      "kept-top-score",
    ]);
    expect(stages.dropped.map((candidate) => candidate.refId)).toEqual(["dropped-middle"]);
    expect(stages.dropped[0]?.score).toBe(0.4);
  });

  it("preserves score composition for candidate diagnostics", () => {
    const item = snippet("fact", 0.72);
    item.scoreDetails = {
      profile: "personal_fact",
      semantic: 0.82,
      tierBoost: 0,
      rrfBoost: 0.01,
      relevance: 0.83,
      mmrLambda: 0.85,
      redundancy: 0.2,
      finalScore: 0.72,
      channels: ["vec_summary"],
      bypassedThreshold: false,
    };

    const stages = buildLocalRetrievalLogStages({ snippets: [item] });

    expect(stages.filtered[0]?.scoreDetails).toEqual(item.scoreDetails);
  });
});
