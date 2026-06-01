import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runFeedbackExperience } from "../../../core/experience/feedback-builder.js";
import {
  isRepairCandidatePolicy,
  mintRepairCandidate,
} from "../../../core/skill/repair-candidate.js";
import type {
  EpisodeId,
  FeedbackRow,
  PolicyId,
  RuntimeNamespace,
  TraceRow,
} from "../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { NOW, seedTrace, vec } from "../feedback/_helpers.js";

const namespace: RuntimeNamespace = {
  agentKind: "hermes",
  profileId: "default",
  workspaceId: "workspace",
};

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
    polarity: "neutral",
    magnitude: 1,
    rationale:
      "Verifier feedback: failed, Time Limit Exceeded on the O(n^2) bitset. Instead use FFT/autocorrelation to count the triplets in O(n log n).",
    raw: { source: "verifier", verifier: { reward: 0, passed: 3, total: 4 } },
    ...partial,
  };
}

async function makeConstructiveNegative(handle: TmpDbHandle, trace: TraceRow): Promise<PolicyId> {
  const result = await runFeedbackExperience(
    {
      feedback: feedback(),
      episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -0.51 },
      trace,
    },
    { repos: handle.repos, embedder: null, namespace, now: () => NOW },
  );
  expect(result.policyId).toBeTruthy();
  return result.policyId!;
}

describe("repair candidate minting", () => {
  let handle: TmpDbHandle;
  let trace: TraceRow;

  beforeEach(() => {
    handle = makeTmpDb({ agent: "hermes" });
    trace = seedTrace(handle, {
      id: "tr_feedback",
      episodeId: "ep_feedback",
      sessionId: "se_feedback",
      userText: "Count arithmetic-progression triplets in the array.",
      agentText: "Used an O(n^2) bitset and timed out.",
      vec: vec([1, 0, 0]),
    });
  });

  afterEach(() => {
    handle.cleanup();
  });

  it("mints a candidate skill (eta=floor, repairOrigin, strict) from a constructive negative", async () => {
    const policyId = await makeConstructiveNegative(handle, trace);
    const policy = handle.repos.policies.getById(policyId)!;
    expect(isRepairCandidatePolicy(policy)).toBe(true);

    const skillId = mintRepairCandidate(policy, {
      repos: handle.repos,
      embedder: null,
      now: () => NOW,
    });
    expect(skillId).toBeTruthy();

    const skill = handle.repos.skills.getById(skillId!)!;
    expect(skill.status).toBe("candidate");
    expect(skill.eta).toBeCloseTo(0.1, 6); // born at the retrieval floor, no head start
    expect(skill.repairOrigin).toBe(true);
    expect(skill.strictTrial).toBe(true); // verifier origin → full-pass-only trials
    expect(skill.sourcePolicyIds).toEqual([policyId]);
    expect(skill.trialsAttempted).toBe(0);
    expect(skill.invocationGuide.toLowerCase()).toContain("fft");
  });

  it("dedups: a second mint for the same policy returns null (rebuild path owns it)", async () => {
    const policyId = await makeConstructiveNegative(handle, trace);
    const policy = handle.repos.policies.getById(policyId)!;

    const first = mintRepairCandidate(policy, { repos: handle.repos, embedder: null, now: () => NOW });
    expect(first).toBeTruthy();
    const second = mintRepairCandidate(policy, { repos: handle.repos, embedder: null, now: () => NOW });
    expect(second).toBeNull();
    expect(handle.repos.skills.list({ limit: 50 }).length).toBe(1);
  });

  it("uses structured name without policy-id suffix and keeps it readable", async () => {
    const longFix =
      "Verifier feedback failed with Time Limit Exceeded so instead use the fast fourier transform autocorrelation counting technique to avoid the quadratic blowup in this arithmetic progression triplet problem";
    const result = await runFeedbackExperience(
      {
        feedback: feedback({ id: "fb_long" as FeedbackRow["id"], rationale: longFix }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -0.51 },
        trace,
      },
      { repos: handle.repos, embedder: null, namespace, now: () => NOW },
    );
    const policy = handle.repos.policies.getById(result.policyId!)!;
    expect(isRepairCandidatePolicy(policy)).toBe(true);

    const skillId = mintRepairCandidate(policy, { repos: handle.repos, embedder: null, now: () => NOW });
    expect(skillId).toBeTruthy();
    const skill = handle.repos.skills.getById(skillId!)!;
    expect(skill.name).toMatch(/^[a-z0-9_]+$/);
    expect(skill.name.length).toBeLessThanOrEqual(48);
    expect(skill.name).not.toContain(policy.id.slice(-5).toLowerCase());
  });

  it("does not mint from a bare-verdict negative (no fix → not a repair candidate)", async () => {
    const result = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_bare" as FeedbackRow["id"],
          rationale:
            "Verifier feedback: failed. Verifier reward: 0.0. passed: 3, total: 4. Time Limit Exceeded. Please reflect on what to improve next time.",
          raw: { source: "verifier", verifier: { reward: 0, passed: 3, total: 4 } },
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -0.51 },
        trace,
      },
      { repos: handle.repos, embedder: null, namespace, now: () => NOW },
    );
    const policy = handle.repos.policies.getById(result.policyId!)!;
    expect(isRepairCandidatePolicy(policy)).toBe(false);
    expect(mintRepairCandidate(policy, { repos: handle.repos, embedder: null, now: () => NOW })).toBeNull();
  });
});
