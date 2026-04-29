import { describe, expect, it } from "vitest";

import { runTier1 } from "../../../core/retrieval/tier1-skill.js";
import type {
  RetrievalConfig,
  RetrievalRepos,
  SkillStatus,
} from "../../../core/retrieval/types.js";
import type { EmbeddingVector, SkillId } from "../../../core/types.js";

const cfg: RetrievalConfig = {
  tier1TopK: 2,
  tier2TopK: 5,
  tier3TopK: 2,
  candidatePoolFactor: 4,
  weightCosine: 0.6,
  weightPriority: 0.4,
  mmrLambda: 0.7,
  includeLowValue: false,
  rrfConstant: 60,
  minSkillEta: 0.6,
  minTraceSim: 0.3,
  tagFilter: "auto",
  decayHalfLifeDays: 30,
  llmFilterEnabled: false,
  llmFilterMaxKeep: 4,
  llmFilterMinCandidates: 1,
};

const qv: EmbeddingVector = Float32Array.from([1, 0, 0]);

function makeRepo(rows: Array<{ id: string; status: SkillStatus; eta: number; score: number }>) {
  const repo: RetrievalRepos["skills"] = {
    searchByVector(_vec, k, opts) {
      return rows
        .filter((r) =>
          opts?.statusIn ? opts.statusIn.includes(r.status) : true,
        )
        .slice(0, k)
        .map((r) => ({
          id: r.id,
          score: r.score,
          meta: { name: r.id, status: r.status, eta: r.eta, gain: 0 },
        }));
    },
    getById(id) {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      return {
        id: id as SkillId,
        name: r.id,
        status: r.status,
        invocationGuide: `run ${r.id}`,
        eta: r.eta,
      };
    },
  };
  return repo;
}

describe("retrieval/tier1", () => {
  it("returns top-K skills above η threshold", async () => {
    const repo = makeRepo([
      { id: "a", status: "active", eta: 0.9, score: 0.95 },
      { id: "b", status: "active", eta: 0.4, score: 0.9 }, // drops on η
      { id: "c", status: "active", eta: 0.7, score: 0.8 },
      { id: "d", status: "archived", eta: 0.8, score: 0.75 }, // drops on status
    ]);
    const kept = await runTier1(
      { repos: { skills: repo }, config: cfg },
      { kind: "embedded", queryVec: qv, rawText: "x" },
    );
    const ids = kept.map((k) => String(k.refId)).sort();
    expect(ids).toEqual(["a", "c"]);
  });

  it("returns [] when cosine below minTraceSim", async () => {
    const repo = makeRepo([{ id: "a", status: "active", eta: 0.9, score: 0.1 }]);
    const kept = await runTier1(
      { repos: { skills: repo }, config: cfg },
      { kind: "embedded", queryVec: qv, rawText: "x" },
    );
    expect(kept.length).toBe(0);
  });
});
