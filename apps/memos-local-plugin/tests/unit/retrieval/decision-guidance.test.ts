import { describe, expect, it } from "vitest";

import { collectDecisionGuidance } from "../../../core/retrieval/decision-guidance.js";
import type { RankedCandidate } from "../../../core/retrieval/ranker.js";
import type {
  EpisodeCandidate,
  RetrievalRepos,
  SkillCandidate,
} from "../../../core/retrieval/types.js";

const NOW = 1_700_000_000_000 as never;

function rankedSkill(
  patch: Partial<SkillCandidate> & Pick<SkillCandidate, "refId">,
): RankedCandidate {
  const candidate: SkillCandidate = {
    tier: "tier1",
    refKind: "skill",
    refId: patch.refId,
    cosine: 0.9,
    ts: NOW,
    vec: null,
    skillName: "Skill",
    eta: 0.9,
    status: "active",
    invocationGuide: "Do the thing.",
    ...patch,
  };
  return {
    candidate,
    relevance: 0.9,
    rrf: 0.01,
    score: 0.9,
    normSq: null,
  };
}

function rankedEpisode(refId: string): RankedCandidate {
  const candidate: EpisodeCandidate = {
    tier: "tier2",
    refKind: "episode",
    refId: refId as never,
    cosine: 0.9,
    ts: NOW,
    vec: null,
    sessionId: "s1" as never,
    summary: "Episode rollup.",
    maxValue: 0.8 as never,
    meanPriority: 0.7,
  };
  return {
    candidate,
    relevance: 0.9,
    rrf: 0.01,
    score: 0.9,
    normSq: null,
  };
}

describe("retrieval/decision-guidance", () => {
  it("uses skill-local decision guidance before source policies", () => {
    const repos = {
      policies: {
        list: () => {
          throw new Error("policy lookup should not be needed");
        },
      },
    } as unknown as RetrievalRepos;

    const result = collectDecisionGuidance({
      ranked: [
        rankedSkill({
          refId: "sk1" as never,
          sourcePolicyIds: ["policy1" as never],
          decisionGuidance: {
            preference: ["Prefer the skill-specific setup."],
            antiPattern: ["Avoid the skill-specific trap."],
          },
        }),
      ],
      repos,
    });

    expect(result.preference.map((g) => g.text)).toEqual([
      "Prefer the skill-specific setup.",
    ]);
    expect(result.antiPattern.map((g) => g.text)).toEqual([
      "Avoid the skill-specific trap.",
    ]);
    expect(result.preference[0]?.sourceSkillIds).toEqual(["sk1"]);
    expect(result.preference[0]?.sourcePolicyIds).toEqual([]);
    expect(result.policyIdsTouched).toEqual([]);
    expect(result.skillIdsTouched).toEqual(["sk1"]);
  });

  it("falls back to source policy guidance for legacy skills", () => {
    const repos = {
      policies: {
        list: () => [
          {
            id: "policy1",
            title: "Legacy policy",
            sourceEpisodeIds: [],
            decisionGuidance: {
              preference: ["Prefer the policy fallback."],
              antiPattern: ["Avoid the policy fallback."],
            },
          },
        ],
      },
    } as unknown as RetrievalRepos;

    const result = collectDecisionGuidance({
      ranked: [
        rankedSkill({
          refId: "sk1" as never,
          sourcePolicyIds: ["policy1" as never],
          decisionGuidance: { preference: [], antiPattern: [] },
        }),
      ],
      repos,
    });

    expect(result.preference.map((g) => g.text)).toEqual([
      "Prefer the policy fallback.",
    ]);
    expect(result.antiPattern.map((g) => g.text)).toEqual([
      "Avoid the policy fallback.",
    ]);
    expect(result.preference[0]?.sourceSkillIds).toEqual([]);
    expect(result.preference[0]?.sourcePolicyIds).toEqual(["policy1"]);
    expect(result.policyIdsTouched).toEqual(["policy1"]);
    expect(result.skillIdsTouched).toEqual([]);
  });

  it("uses episode rollup refId to collect policy guidance", () => {
    const repos = {
      policies: {
        list: () => [
          {
            id: "policy_ep",
            title: "Episode policy",
            sourceEpisodeIds: ["ep1"],
            decisionGuidance: {
              preference: ["Prefer the episode-level lesson."],
              antiPattern: ["Avoid the episode-level trap."],
            },
          },
        ],
      },
    } as unknown as RetrievalRepos;

    const result = collectDecisionGuidance({
      ranked: [rankedEpisode("ep1")],
      repos,
    });

    expect(result.preference.map((g) => g.text)).toEqual([
      "Prefer the episode-level lesson.",
    ]);
    expect(result.antiPattern.map((g) => g.text)).toEqual([
      "Avoid the episode-level trap.",
    ]);
    expect(result.policyIdsTouched).toEqual(["policy_ep"]);
  });
});
