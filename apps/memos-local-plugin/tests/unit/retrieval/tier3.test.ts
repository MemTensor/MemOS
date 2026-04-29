import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runTier3 } from "../../../core/retrieval/tier3-world.js";
import type { RetrievalConfig } from "../../../core/retrieval/types.js";
import type { EmbeddingVector, WorldModelId } from "../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

const NOW = 1_700_000_000_000;

function vec(arr: number[]): EmbeddingVector {
  return Float32Array.from(arr) as unknown as EmbeddingVector;
}

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
  minTraceSim: 0.3,
  tagFilter: "auto",
  decayHalfLifeDays: 30,
  llmFilterEnabled: false,
  llmFilterMaxKeep: 4,
  llmFilterMinCandidates: 1,
};

describe("retrieval/tier3 (with real sqlite)", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
    handle.repos.worldModel.upsert({
      id: "wm_docker" as WorldModelId,
      title: "docker-compose",
      body: "docker creates containers; compose orchestrates",
      structure: { environment: [], inference: [], constraints: [] },
      domainTags: ["docker"],
      confidence: 0.9,
      policyIds: [],
      sourceEpisodeIds: [],
      inducedBy: "",
      vec: vec([1, 0, 0]),
      createdAt: NOW as never,
      updatedAt: NOW as never,
      status: "active",
    });
    handle.repos.worldModel.upsert({
      id: "wm_http" as WorldModelId,
      title: "http-pool",
      body: "http clients need connection pools",
      structure: { environment: [], inference: [], constraints: [] },
      domainTags: ["http"],
      confidence: 0.8,
      policyIds: [],
      sourceEpisodeIds: [],
      inducedBy: "",
      vec: vec([0, 1, 0]),
      createdAt: NOW as never,
      updatedAt: NOW as never,
      status: "active",
    });
  });
  afterEach(() => handle.cleanup());

  it("returns the closest world-model by cosine", async () => {
    const out = await runTier3(
      { repos: { worldModel: handle.repos.worldModel }, config: cfg },
      { queryVec: vec([1, 0, 0]) },
    );
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(String(out[0]!.refId)).toBe("wm_docker");
    expect(out[0]!.title).toBe("docker-compose");
    expect(out[0]!.body).toContain("containers");
  });

  it("returns a candidate pool sized by tier3TopK · candidatePoolFactor", async () => {
    // Ranker is responsible for enforcing the final tier3TopK cap; the
    // tier itself returns up to `tier3TopK · candidatePoolFactor` so
    // multi-channel evidence has room to surface.
    const out = await runTier3(
      { repos: { worldModel: handle.repos.worldModel }, config: { ...cfg, tier3TopK: 1 } },
      { queryVec: vec([1, 1, 0]) },
    );
    const expectedMax = Math.max(1, Math.ceil(1 * cfg.candidatePoolFactor));
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(expectedMax);
  });

  it("returns [] when cosine below minTraceSim", async () => {
    // Query is orthogonal to both seeded world models → cosine ≈ 0.
    const out = await runTier3(
      {
        repos: { worldModel: handle.repos.worldModel },
        config: { ...cfg, minTraceSim: 0.5 },
      },
      { queryVec: vec([0, 0, 1]) },
    );
    expect(out.length).toBe(0);
  });
});
