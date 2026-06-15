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
    decisionGuidance: { preference: [], antiPattern: [] },
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
    expect(r.row.invocationGuide.toLowerCase()).toContain("alpine");
    expect(r.row.vec).not.toBeNull();
    expect(r.row.sourcePolicyIds).toContain("po_pkg");
    expect(r.row.eta).toBeGreaterThanOrEqual(makeSkillConfig().minEtaForRetrieval);
  });

  it("uses only trigger context and summary as the skill vector source", async () => {
    const r = await buildSkillRow(
      {
        draft: makeDraft({
          retrievalBlurb: "retrieval-only text must not affect dedupe",
          triggerContext: "Alpine Python package builds fail because native headers are missing.",
          summary: "Install native headers before retrying the package build.",
          steps: [{ title: "apk add", body: "install libffi-dev openssl-dev" }],
        }),
        policy: mkPolicy(),
        evidenceEpisodeIds: ["ep_1" as PolicyRow["sourceEpisodeIds"][number]],
        evidenceUserTexts: ["user asked for cffi today"],
      },
      { embedder: fakeEmbedder(), log, config: makeSkillConfig() },
    );

    expect(r.vecSource).toBe(
      [
        "Alpine Python package builds fail because native headers are missing.",
        "Install native headers before retrying the package build.",
      ].join("\n"),
    );
    expect(r.vecSource).not.toContain("retrieval-only");
    expect(r.vecSource).not.toContain("apk add");
    expect(r.vecSource).not.toContain("user asked");
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
      evidenceAnchors: [],
      vec: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
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

  it("preserves strictTrial across rebuild (verifier-origin trial judgment must survive)", async () => {
    const existing = {
      id: "sk_strict" as SkillRow["id"],
      name: "alpine_pip_apply",
      status: "candidate",
      invocationGuide: "",
      procedureJson: null,
      eta: 0.4,
      support: 2,
      gain: 0.3,
      trialsAttempted: 0,
      trialsPassed: 0,
      sourcePolicyIds: ["po_pkg" as PolicyRow["id"]],
      sourceWorldModelIds: [],
      evidenceAnchors: [],
      vec: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      strictTrial: true,
      repairOrigin: true,
    } as SkillRow;
    const r = await buildSkillRow(
      { draft: makeDraft(), policy: mkPolicy(), evidenceEpisodeIds: [], existing },
      { embedder: null, log, config: makeSkillConfig() },
    );
    expect(r.row.strictTrial).toBe(true);
    // repairOrigin is intentionally dropped on rebuild — graduate on normal thresholds.
    expect(r.row.repairOrigin).toBeFalsy();
  });

  it("carries graduatedFromRepairName forward so single-use rename stays spent", async () => {
    const procedureJson = {
      summary: "old",
      retrievalBlurb: "old blurb",
      triggerContext: "",
      policyContentHash: "h0",
      outputLanguage: "en" as const,
      parameters: [],
      preconditions: [],
      steps: [{ title: "old", body: "old" }],
      examples: [],
      decisionGuidance: { preference: [], antiPattern: [] },
      tags: [],
      tools: [],
      graduatedFromRepairName: true,
    };
    const existing = {
      id: "sk_grad" as SkillRow["id"],
      name: "alpine_pip_apply",
      status: "active",
      invocationGuide: "",
      procedureJson,
      eta: 0.6,
      support: 3,
      gain: 0.3,
      trialsAttempted: 4,
      trialsPassed: 3,
      sourcePolicyIds: ["po_pkg" as PolicyRow["id"]],
      sourceWorldModelIds: [],
      evidenceAnchors: [],
      vec: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 2,
    } as SkillRow;
    const r = await buildSkillRow(
      { draft: makeDraft(), policy: mkPolicy(), evidenceEpisodeIds: [], existing },
      { embedder: null, log, config: makeSkillConfig() },
    );
    expect(
      (r.row.procedureJson as { graduatedFromRepairName?: boolean } | null)
        ?.graduatedFromRepairName,
    ).toBe(true);
  });

  it("renders zh invocation guide when outputLanguage is zh", async () => {
    const r = await buildSkillRow(
      {
        draft: makeDraft({
          name: "django_patch_apply",
          retrievalBlurb: "适用于 django 补丁无法落盘的场景。",
          triggerContext: "当补丁应用失败并需要通过 WRAPPER_PATH 修复时。",
          summary: "通过 WRAPPER_PATH 安全应用补丁并验证结果。",
          steps: [{ title: "应用补丁", body: "执行补丁并检查返回结果" }],
        }),
        policy: mkPolicy(),
        evidenceEpisodeIds: [],
        outputLanguage: "zh",
      },
      { embedder: null, log, config: makeSkillConfig() },
    );
    expect(r.row.invocationGuide).toContain("**检索与适用场景**");
    expect(r.row.invocationGuide).toContain("**触发上下文**");
    expect(r.row.invocationGuide).toContain("**执行步骤**");
    expect(r.row.invocationGuide).not.toContain("**Summary**");
  });
});
