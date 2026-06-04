import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { MemosError, ERROR_CODES } from "../../../agent-contract/errors.js";

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

  it("treats a partial verifier pass (3/4, reward 0) as a failure, not a success_pattern", async () => {
    const result = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_partial" as FeedbackRow["id"],
          polarity: "neutral",
          // The literal word "passed" appears here and used to be substring-matched
          // as a positive signal — even though 3/4 with reward 0 is a failure.
          rationale:
            "Verifier feedback for the previous attempt. Verifier reward: 0.0. passed: 3, total: 4. TimeoutException(): Time Limit Exceeded. Please briefly reflect on what you would keep and what you would improve next time.",
          raw: {
            source: "evoagentbench_gateway_manual_feedback",
            verifier: { reward: 0, passed: 3, total: 4, results: [1, 1, 1, -3] },
          },
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -0.51 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(), namespace, now: () => NOW },
    );

    expect(result.policyId).toBeTruthy();
    const row = handle.repos.policies.getById(result.policyId!);
    expect(row?.experienceType).not.toBe("success_pattern");
    expect(row?.evidencePolarity).toBe("negative");
    expect(row?.skillEligible).toBe(false);
  });

  it("does not mark verifier reflection prompts as skill-eligible even on full pass", async () => {
    const result = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_full_reflect" as FeedbackRow["id"],
          polarity: "positive",
          rationale:
            "Verifier feedback for the previous attempt. Verifier reward: 1.0. passed: 4, total: 4. Please briefly reflect on what you would keep and what you would improve next time.",
          raw: {
            source: "evoagentbench_gateway_manual_feedback",
            verifier: { reward: 1, passed: 4, total: 4 },
          },
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: 1 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(), namespace, now: () => NOW },
    );

    const row = handle.repos.policies.getById(result.policyId!)!;
    expect(row.experienceType).toBe("success_pattern");
    expect(row.evidencePolarity).toBe("positive");
    expect(row.skillEligible).toBe(false);
  });

  it("does not mark HEARTBEAT_OK verifier responses as skill-eligible", async () => {
    const result = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_heartbeat" as FeedbackRow["id"],
          polarity: "positive",
          rationale: "Verifier feedback: success. HEARTBEAT_OK",
          raw: { source: "verifier", verifier: { reward: 1, passed: 1, total: 1 } },
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: 1 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(), namespace, now: () => NOW },
    );

    const row = handle.repos.policies.getById(result.policyId!)!;
    expect(row.experienceType).toBe("success_pattern");
    expect(row.skillEligible).toBe(false);
  });

  it("records the suggested fix as a preference on a constructive negative (avoid + do-Y in one record)", async () => {
    const result = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_fix" as FeedbackRow["id"],
          polarity: "neutral",
          // Failed, but the feedback names a concrete corrective direction.
          rationale:
            "Verifier feedback: failed, Time Limit Exceeded on the O(n^2) bitset. Instead use FFT/autocorrelation to count the triplets in O(n log n).",
          raw: { source: "verifier", verifier: { reward: 0, passed: 3, total: 4 } },
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -0.51 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(), namespace, now: () => NOW },
    );

    expect(result.policyId).toBeTruthy();
    const row = handle.repos.policies.getById(result.policyId!);
    // Stays a negative, non-skill-eligible record...
    expect(row?.evidencePolarity).toBe("negative");
    expect(row?.skillEligible).toBe(false);
    // ...but now also carries the suggested fix as a preference.
    expect(row?.decisionGuidance.preference.join("\n").toLowerCase()).toContain("fft");
  });

  it("does NOT record a fix on a bare-verdict negative (no constructive direction)", async () => {
    const result = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_bare" as FeedbackRow["id"],
          polarity: "neutral",
          rationale:
            "Verifier feedback for the previous attempt. Verifier reward: 0.0. passed: 3, total: 4. TimeoutException(): Time Limit Exceeded. Please briefly reflect on what you would keep and what you would improve next time.",
          raw: { source: "verifier", verifier: { reward: 0, passed: 3, total: 4 } },
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -0.51 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(), namespace, now: () => NOW },
    );

    expect(result.policyId).toBeTruthy();
    const row = handle.repos.policies.getById(result.policyId!);
    expect(row?.evidencePolarity).toBe("negative");
    expect(row?.skillEligible).toBe(false);
    // Pure warning: the avoidance is present, no fabricated fix.
    expect(row?.decisionGuidance.preference).toEqual([]);
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

    expect(avoid.policyId).not.toBe(ok.policyId);
    const parent = handle.repos.policies.getById(ok.policyId!);
    const sibling = handle.repos.policies.getById(avoid.policyId!);
    expect(parent?.status).toBe("active");
    expect(parent?.skillEligible).toBe(true);
    expect(["candidate", "active"]).toContain(sibling?.status);
    expect(sibling?.sourceFeedbackIds).toContain("fb_avoid");
  });

  it("does not treat verifier similarity as an active-hit candidate fork", async () => {
    const base = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_base" as FeedbackRow["id"],
          rationale: "Verifier failed: avoid wrong SEC 13F issuer field.",
          raw: { source: "verifier", score: -1 },
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -1 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(), namespace, now: () => NOW },
    );
    const row = handle.repos.policies.getById(base.policyId!);
    expect(row).toBeTruthy();
    handle.repos.policies.upsert({
      ...row!,
      status: "active",
      support: 10,
      gain: 0.9,
      updatedAt: NOW + 1,
    });

    const follow = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_follow" as FeedbackRow["id"],
          rationale: "Verifier failed again: avoid wrong SEC 13F issuer field.",
          raw: { source: "verifier", score: -1 },
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -1 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(), namespace, now: () => NOW + 2 },
    );

    expect(follow.created).toBe(true);
    expect(follow.policyId).not.toBe(base.policyId);
    const all = handle.repos.policies.list({ limit: 20 });
    const activeRows = all.filter((p) => p.status === "active");
    const candidateRows = all.filter((p) => p.status === "candidate");
    expect(activeRows).toHaveLength(2);
    expect(candidateRows).toHaveLength(0);
  });

  it("merges compatible non-verifier feedback with the existing similarity threshold", async () => {
    handle.repos.policies.insert({
      id: "po_merge_family" as never,
      ownerAgentKind: "hermes",
      ownerProfileId: "default",
      ownerWorkspaceId: "workspace",
      title: "SEC 13F extraction rule",
      trigger: "when parsing 13F",
      procedure: "avoid wrong issuer field",
      verification: "issuer matches filing",
      boundary: "",
      support: 1,
      gain: 0.2,
      status: "candidate",
      experienceType: "failure_avoidance",
      evidencePolarity: "negative",
      mergeFamily: null,
      sourceEpisodeIds: ["ep_feedback" as EpisodeId],
      sourceFeedbackIds: [],
      sourceTraceIds: [trace.id],
      inducedBy: "feedback.experience.v1",
      decisionGuidance: { preference: [], antiPattern: ["avoid wrong issuer field"] },
      skillEligible: false,
      createdAt: NOW,
      updatedAt: NOW,
      vec: vec([1, 0, 0]),
    });

    const merged = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_merge_family" as FeedbackRow["id"],
          rationale: "Avoid wrong SEC 13F issuer field.",
          raw: {},
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -1 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(), namespace, now: () => NOW + 3 },
    );

    expect(merged.policyId).toBe("po_merge_family");
    const row = handle.repos.policies.getById("po_merge_family" as never);
    expect(row?.support).toBe(2);
    expect(row?.evidencePolarity).toBe("negative");
    expect(row?.mergeFamily).toBe("failure_avoidance");
    expect(row?.sourceFeedbackIds).toContain("fb_merge_family");
  });

  it("does not split compatible manual feedback just because policy source kind is not persisted", async () => {
    handle.repos.policies.insert({
      id: "po_manual_merge" as never,
      ownerAgentKind: "hermes",
      ownerProfileId: "default",
      ownerWorkspaceId: "workspace",
      title: "SEC 13F extraction rule",
      trigger: "when parsing 13F",
      procedure: "avoid wrong issuer field",
      verification: "issuer matches filing",
      boundary: "",
      support: 1,
      gain: 0.2,
      status: "candidate",
      experienceType: "failure_avoidance",
      evidencePolarity: "negative",
      mergeFamily: null,
      sourceEpisodeIds: ["ep_feedback" as EpisodeId],
      sourceFeedbackIds: [],
      sourceTraceIds: [trace.id],
      inducedBy: "feedback.experience.v1",
      decisionGuidance: { preference: [], antiPattern: ["avoid wrong issuer field"] },
      skillEligible: false,
      createdAt: NOW,
      updatedAt: NOW,
      vec: vec([1, 0, 0]),
    });

    const merged = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_manual_merge" as FeedbackRow["id"],
          rationale: "Avoid wrong SEC 13F issuer field.",
          raw: { source: "manual" },
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -1 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(), namespace, now: () => NOW + 4 },
    );

    expect(merged.policyId).toBe("po_manual_merge");
    const row = handle.repos.policies.getById("po_manual_merge" as never);
    expect(row?.support).toBe(2);
    expect(row?.sourceFeedbackIds).toContain("fb_manual_merge");
  });

  it("uses the stricter threshold when task or issue key parts are missing", async () => {
    handle.repos.policies.insert({
      id: "po_strict_missing_key" as never,
      ownerAgentKind: "hermes",
      ownerProfileId: "default",
      ownerWorkspaceId: "workspace",
      title: "Avoid",
      trigger: "Avoid",
      procedure: "Avoid",
      verification: "",
      boundary: "",
      support: 1,
      gain: 0.2,
      status: "candidate",
      experienceType: "failure_avoidance",
      evidencePolarity: "negative",
      mergeFamily: null,
      sourceEpisodeIds: ["ep_feedback" as EpisodeId],
      sourceFeedbackIds: [],
      sourceTraceIds: [trace.id],
      inducedBy: "feedback.experience.v1",
      decisionGuidance: { preference: [], antiPattern: ["avoid"] },
      skillEligible: false,
      createdAt: NOW,
      updatedAt: NOW,
      vec: vec([1, 0]),
    });

    const result = await runFeedbackExperience(
      {
        feedback: feedback({
          id: "fb_strict_missing_key" as FeedbackRow["id"],
          rationale: "Avoid wrong.",
          raw: {},
        }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -1 },
        trace,
      },
      { repos: handle.repos, embedder: fakeEmbedder(vec([0.8, 0.6])), namespace, now: () => NOW + 5 },
    );

    expect(result.policyId).not.toBe("po_strict_missing_key");
    const original = handle.repos.policies.getById("po_strict_missing_key" as never);
    expect(original?.support).toBe(1);
  });

  it("passes compressed all-trace context to refiner in trace order", async () => {
    const tr2 = seedTrace(handle, {
      id: "tr_feedback_2",
      episodeId: "ep_feedback",
      sessionId: "se_feedback",
      ts: (NOW + 1) as TraceRow["ts"],
      userText: "Second turn user",
      agentText: "Second turn agent",
      vec: vec([1, 0, 0]),
    });
    const tr3 = seedTrace(handle, {
      id: "tr_feedback_3",
      episodeId: "ep_feedback",
      sessionId: "se_feedback",
      ts: (NOW + 2) as TraceRow["ts"],
      userText: "Third turn user",
      agentText: "Third turn agent",
      vec: vec([1, 0, 0]),
    });
    const tr4 = seedTrace(handle, {
      id: "tr_feedback_4",
      episodeId: "ep_feedback",
      sessionId: "se_feedback",
      ts: (NOW + 3) as TraceRow["ts"],
      userText: "Fourth turn user",
      agentText: "Fourth turn agent",
      vec: vec([1, 0, 0]),
    });

    const seenPrompts: string[] = [];
    const llm = {
      completeJson: vi.fn(async (messages: Array<{ role: string; content: string }>) => {
        const userPayload = messages.find((m) => m.role === "user")?.content ?? "";
        seenPrompts.push(userPayload);
        return {
          value: {
            title: "trace-order",
            trigger: "when parsing SEC 13F",
            procedure: "apply corrected extraction",
            caveats: ["avoid wrong field"],
            verification: "check issuer field",
            confidence: 0.9,
          },
        };
      }),
    } as unknown as {
      completeJson: (
        messages: Array<{ role: string; content: string }>,
        opts?: Record<string, unknown>,
      ) => Promise<{ value: Record<string, unknown> }>;
    };

    const result = await runFeedbackExperience(
      {
        feedback: feedback({ id: "fb_trace_order" as FeedbackRow["id"] }),
        episode: {
          id: "ep_feedback" as EpisodeId,
          traceIds: [trace.id, tr2.id, tr3.id, tr4.id],
          rTask: -1,
        },
        trace: tr4,
      },
      {
        repos: handle.repos,
        embedder: fakeEmbedder(),
        llm: llm as never,
        namespace,
        now: () => NOW,
      },
    );

    expect(result.policyId).toBeTruthy();
    const prompt = seenPrompts.at(-1) ?? "";
    expect(prompt).toContain("Turn 1:");
    expect(prompt).toContain("Turn 2:");
    expect(prompt).toContain("Turn 3:");
    expect(prompt).toContain("Turn 4:");
    expect(prompt.indexOf("Turn 1:")).toBeLessThan(prompt.indexOf("Turn 4:"));
  });

  it("logs fallback reason with preallocated policyId (disabled and timeout)", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    const disabled = await runFeedbackExperience(
      {
        feedback: feedback({ id: "fb_disabled" as FeedbackRow["id"] }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -1 },
        trace,
      },
      {
        repos: handle.repos,
        embedder: fakeEmbedder(),
        namespace,
        now: () => NOW,
        log: { info, warn },
      },
    );
    expect(disabled.policyId).toBeTruthy();
    expect(info).toHaveBeenCalledWith(
      "feedback.experience.refine_fallback",
      expect.objectContaining({
        policyId: disabled.policyId,
        feedbackId: "fb_disabled",
        fallbackReason: "llm_disabled",
      }),
    );

    const timeoutLlm = {
      completeJson: vi.fn(async () => {
        throw new MemosError(ERROR_CODES.LLM_TIMEOUT, "timed out");
      }),
    };
    const timedOut = await runFeedbackExperience(
      {
        feedback: feedback({ id: "fb_timeout" as FeedbackRow["id"] }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds: [trace.id], rTask: -1 },
        trace,
      },
      {
        repos: handle.repos,
        embedder: fakeEmbedder(),
        namespace,
        now: () => NOW + 1,
        llm: timeoutLlm as never,
        log: { info, warn },
      },
    );
    expect(timedOut.policyId).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      "feedback.experience.refine_fallback",
      expect.objectContaining({
        policyId: timedOut.policyId,
        feedbackId: "fb_timeout",
        fallbackReason: "llm_timeout",
      }),
    );
  });

  it("skips experience when protected traces cannot compress under budget", async () => {
    const traceIds: TraceRow["id"][] = [];
    for (let i = 0; i < 30; i++) {
      const id = `tr_prot_${i}` as TraceRow["id"];
      traceIds.push(id);
      seedTrace(handle, {
        id,
        episodeId: "ep_feedback",
        sessionId: "se_feedback",
        ts: (NOW + i) as TraceRow["ts"],
        userText: `turn ${i} `.repeat(60),
        agentText: `agent ${i} `.repeat(80),
        reflection: "PIVOTAL",
        vec: vec([1, 0, 0]),
      });
    }
    const last = traceIds[traceIds.length - 1]!;
    const llm = { completeJson: vi.fn(async () => ({ value: {} })) };
    const result = await runFeedbackExperience(
      {
        feedback: feedback({ id: "fb_prot" as FeedbackRow["id"] }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds, rTask: -1 },
        trace: handle.repos.traces.getById(last)!,
      },
      {
        repos: handle.repos,
        embedder: fakeEmbedder(),
        llm: llm as never,
        namespace,
        now: () => NOW,
      },
    );
    expect(result.created).toBe(false);
    expect(result.skippedReason).toBe("context_too_large");
    expect(result.policyId).toBeUndefined();
    expect(llm.completeJson).not.toHaveBeenCalled();
    expect(handle.repos.policies.list({ limit: 50 })).toHaveLength(0);
  });

  it("never drops PIVOTAL traces during context compression", async () => {
    const traceIds: TraceRow["id"][] = [trace.id];
    for (let i = 0; i < 12; i++) {
      const id = `tr_pad_${i}` as TraceRow["id"];
      traceIds.push(id);
      seedTrace(handle, {
        id,
        episodeId: "ep_feedback",
        sessionId: "se_feedback",
        ts: (NOW + 1 + i) as TraceRow["ts"],
        userText: `padding turn ${i} `.repeat(40),
        agentText: `padding agent ${i} `.repeat(50),
        vec: vec([1, 0, 0]),
      });
    }
    const pivotal = seedTrace(handle, {
      id: "tr_pivotal" as TraceRow["id"],
      episodeId: "ep_feedback",
      sessionId: "se_feedback",
      ts: (NOW + 99) as TraceRow["ts"],
      userText: "PIVOTAL_MARKER_TURN user request",
      agentText: "PIVOTAL_MARKER_TURN agent answer",
      reflection: "PIVOTAL",
      vec: vec([1, 0, 0]),
    });
    traceIds.push(pivotal.id);

    const seenPrompts: string[] = [];
    const llm = {
      completeJson: vi.fn(async (messages: Array<{ role: string; content: string }>) => {
        seenPrompts.push(messages.find((m) => m.role === "user")?.content ?? "");
        return {
          value: {
            title: "keep pivotal",
            trigger: "when marker appears",
            procedure: "follow pivotal guidance",
            caveats: [],
            verification: "",
            confidence: 0.8,
          },
        };
      }),
    };

    await runFeedbackExperience(
      {
        feedback: feedback({ id: "fb_pivotal" as FeedbackRow["id"] }),
        episode: { id: "ep_feedback" as EpisodeId, traceIds, rTask: -1 },
        trace: pivotal,
      },
      {
        repos: handle.repos,
        embedder: fakeEmbedder(),
        llm: llm as never,
        namespace,
        now: () => NOW,
      },
    );

    const prompt = seenPrompts.at(-1) ?? "";
    expect(prompt).toContain("PIVOTAL_MARKER_TURN");
  });
});
