import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runFeedbackExperience } from "../../../core/experience/feedback-builder.js";
import { runTier2Experience } from "../../../core/retrieval/tier2-experience.js";
import type {
  EmbeddingVector,
  EpisodeId,
  FeedbackRow,
  RuntimeNamespace,
  TraceRow,
} from "../../../core/types.js";
import type { Embedder } from "../../../core/embedding/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { NOW, seedTrace, vec } from "../feedback/_helpers.js";

const namespace: RuntimeNamespace = {
  agentKind: "hermes",
  profileId: "default",
  workspaceId: "workspace",
};

function fakeEmbedder(vector: EmbeddingVector = vec([1, 0, 0])): Embedder {
  return {
    dimensions: vector.length,
    provider: "local",
    model: "unit-test",
    embedOne: async () => vector,
    embedMany: async (inputs) => inputs.map(() => vector),
    stats: () => ({
      hits: 0,
      misses: 0,
      requests: 0,
      roundTrips: 0,
      failures: 0,
      lastOkAt: NOW,
      lastError: null,
    }),
    resetCache: () => {},
    close: async () => {},
  };
}

function feedback(partial: Partial<FeedbackRow> = {}): FeedbackRow {
  return {
    id: "fb_1" as FeedbackRow["id"],
    ownerAgentKind: "hermes",
    ownerProfileId: "default",
    ownerWorkspaceId: "workspace",
    ts: NOW,
    episodeId: "ep_feedback" as EpisodeId,
    traceId: "tr_feedback" as TraceRow["id"],
    channel: "explicit",
    polarity: "negative",
    magnitude: 1,
    rationale: "Verifier feedback: failed. Avoid extracting the issuer name from the wrong SEC 13F field next time.",
    raw: { source: "verifier", score: -1 },
    ...partial,
  };
}

describe("feedback experience builder", () => {
  let handle: TmpDbHandle;
  let trace: TraceRow;

  beforeEach(() => {
    handle = makeTmpDb({ agent: "hermes" });
    trace = seedTrace(handle, {
      id: "tr_feedback",
      episodeId: "ep_feedback",
      sessionId: "se_feedback",
      userText: "Parse a SEC 13F filing and extract issuer/CUSIP holdings.",
      agentText: "Parsed the wrong issuer field.",
      vec: vec([1, 0, 0]),
    });
  });

  afterEach(() => {
    handle.cleanup();
  });

  it("creates recallable failure-avoidance experience that is not skill-eligible", async () => {
    const result = await runFeedbackExperience(
      {
        feedback: feedback(),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -1 },
        trace,
      },
      {
        repos: handle.repos,
        embedder: fakeEmbedder(),
        namespace,
        now: () => NOW,
      },
    );

    expect(result.policyId).toBeTruthy();
    const row = handle.repos.policies.getById(result.policyId!);
    expect(row?.experienceType).toBe("failure_avoidance");
    expect(row?.evidencePolarity).toBe("negative");
    expect(row?.skillEligible).toBe(false);
    expect(row?.sourceFeedbackIds).toEqual(["fb_1"]);
    expect(row?.decisionGuidance.antiPattern.join("\n")).toContain("SEC 13F");

    const recalled = await runTier2Experience(
      {
        repos: handle.repos,
        config: {
          tier1TopK: 3,
          tier2TopK: 3,
          tier3TopK: 0,
          candidatePoolFactor: 4,
          weightCosine: 0.7,
          weightPriority: 0.3,
          mmrLambda: 0.7,
          includeLowValue: true,
          rrfConstant: 60,
          minSkillEta: 0.1,
          minTraceSim: 0.2,
          tagFilter: "auto",
          decayHalfLifeDays: 30,
          llmFilterEnabled: false,
          llmFilterMaxKeep: 8,
          llmFilterMinCandidates: 99,
        },
      },
      { queryVec: vec([1, 0, 0]) },
    );
    expect(recalled.map((c) => c.refId)).toContain(result.policyId);
  });

  it("merges later avoidance feedback into a success-backed experience without losing skill eligibility", async () => {
    const ok = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_ok" as FeedbackRow["id"],
          polarity: "positive",
          rationale: "Verifier feedback: passed. The SEC 13F parsing result is correct.",
          raw: { source: "verifier", score: 1 },
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: 1 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(), namespace, now: () => NOW },
    );

    const avoid = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_avoid" as FeedbackRow["id"],
          rationale: "Verifier feedback: failed. Avoid using the filename as the issuer name.",
          raw: { source: "verifier", score: -1 },
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -1 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(), namespace, now: () => NOW + 1 },
    );

    expect(avoid.policyId).toBe(ok.policyId);
    const row = handle.repos.policies.getById(ok.policyId!);
    expect(row?.experienceType).toBe("repair_validated");
    expect(row?.evidencePolarity).toBe("mixed");
    expect(row?.skillEligible).toBe(true);
    expect(row?.sourceFeedbackIds?.sort()).toEqual(["fb_avoid", "fb_ok"]);
  });
});
