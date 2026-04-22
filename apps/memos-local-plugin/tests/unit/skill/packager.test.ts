import { describe, it, expect } from "vitest";

import { buildSkillRow } from "../../../core/skill/packager.js";
import { rootLogger } from "../../../core/logger/index.js";
import type { Embedder } from "../../../core/embedding/types.js";
import type { PolicyRow, SkillRow } from "../../../core/types.js";
import { makeDraft, makeSkillConfig, NOW, vec } from "./_helpers.js";

function mkPolicy(): PolicyRow {
  return {
    id: "po_pkg" as PolicyRow["id"],
    title: "install",
    trigger: "pip install errors on alpine",
    procedure: "apk add, retry",
    verification: "pip install succeeds",
    boundary: "alpine",
    support: 4,
    gain: 0.4,
    status: "active",
    sourceEpisodeIds: ["ep_1" as PolicyRow["sourceEpisodeIds"][number]],
    inducedBy: "l2.l2.induction.v1",
    vec: vec([1, 0, 0]),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fakeEmbedder(): Embedder {
  return {
    dimensions: 3,
    provider: "openai_compatible",
    model: "fake",
    async embedOne() {
      return vec([0.1, 0.2, 0.3]);
    },
    async embedMany(inputs) {
      return inputs.map(() => vec([0.1, 0.2, 0.3]));
    },
    stats() {
      return {
        hits: 0,
        misses: 0,
        requests: 0,
        roundTrips: 0,
        failures: 0,
        lastOkAt: null,
        lastError: null,
      };
    },
    resetCache() {
      /* noop */
    },
    async close() {
      /* noop */
    },
  };
}

const log = rootLogger.child({ channel: "core.skill.packager" });

describe("skill/packager", () => {
  it("builds a candidate skill row with embedding + invocation guide", async () => {
    const r = await buildSkillRow(
      {
        draft: makeDraft(),
        policy: mkPolicy(),
        evidenceEpisodeIds: ["ep_1" as PolicyRow["sourceEpisodeIds"][number]],
      },
      { embedder: fakeEmbedder(), log, config: makeSkillConfig({ minSupport: 3 }) },
    );
    expect(r.freshMint).toBe(true);
    expect(r.row.status).toBe("candidate");
    expect(r.row.invocationGuide).toContain("Alpine");
    expect(r.row.vec).not.toBeNull();
    expect(r.row.sourcePolicyIds).toContain("po_pkg");
    expect(r.row.eta).toBeGreaterThanOrEqual(makeSkillConfig().minEtaForRetrieval);
  });

  it("preserves the existing skill id when rebuilding", async () => {
    const existing = {
      id: "sk_old" as SkillRow["id"],
      name: "old",
      status: "active",
      invocationGuide: "",
      procedureJson: null,
      eta: 0.8,
      support: 3,
      gain: 0.3,
      trialsAttempted: 5,
      trialsPassed: 5,
      sourcePolicyIds: ["po_pkg" as PolicyRow["id"]],
      sourceWorldModelIds: [],
      vec: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as SkillRow;
    const r = await buildSkillRow(
      {
        draft: makeDraft(),
        policy: mkPolicy(),
        evidenceEpisodeIds: [],
        existing,
      },
      { embedder: null, log, config: makeSkillConfig() },
    );
    expect(r.row.id).toBe("sk_old");
    expect(r.row.trialsAttempted).toBe(5);
    expect(r.freshMint).toBe(false);
  });

  it("survives embedder failure", async () => {
    const bad: Embedder = {
      ...fakeEmbedder(),
      async embedOne() {
        throw new Error("embed boom");
      },
    };
    const r = await buildSkillRow(
      {
        draft: makeDraft(),
        policy: mkPolicy(),
        evidenceEpisodeIds: [],
      },
      { embedder: bad, log, config: makeSkillConfig() },
    );
    expect(r.row.vec).toBeNull();
  });
});
