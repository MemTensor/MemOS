import { describe, expect, it } from "vitest";

import { runTier2Experience } from "../../../core/retrieval/tier2-experience.js";
import type { RetrievalConfig, RetrievalRepos } from "../../../core/retrieval/types.js";
import type { EmbeddingVector, PolicyId } from "../../../core/types.js";

const NOW = 1_700_000_000_000 as never;

function vec(arr: number[]): EmbeddingVector {
  return Float32Array.from(arr) as unknown as EmbeddingVector;
}

const cfg: RetrievalConfig = {
  tier1TopK: 3,
  tier2TopK: 3,
  tier3TopK: 2,
  candidatePoolFactor: 2,
  weightCosine: 0.6,
  weightPriority: 0.4,
  mmrLambda: 0.7,
  includeLowValue: false,
  rrfConstant: 60,
  minSkillEta: 0.5,
  minTraceSim: 0.3,
  tagFilter: "auto",
  keywordTopK: 20,
  decayHalfLifeDays: 30,
  llmFilterEnabled: false,
  llmFilterMaxKeep: 4,
  llmFilterMinCandidates: 1,
};

type PolicyRow = NonNullable<ReturnType<RetrievalRepos["policies"]["getById"]>>;

function makePolicy(
  id: string,
  partial: Partial<PolicyRow> = {},
): PolicyRow {
  return {
    id,
    title: partial.title ?? `policy ${id}`,
    trigger: partial.trigger ?? "when parsing SEC 13F",
    procedure: partial.procedure ?? "use holdings table fields",
    verification: partial.verification ?? "issuer matches row",
    boundary: partial.boundary ?? "",
    support: partial.support ?? 1,
    gain: partial.gain ?? 0.1,
    status: partial.status ?? "active",
    experienceType: partial.experienceType ?? "failure_avoidance",
    evidencePolarity: partial.evidencePolarity ?? "negative",
    salience: partial.salience ?? 0.5,
    confidence: partial.confidence ?? 0.7,
    skillEligible: partial.skillEligible ?? false,
    sourceEpisodeIds: partial.sourceEpisodeIds ?? [],
    sourceFeedbackIds: partial.sourceFeedbackIds ?? ["fb1" as never],
    sourceTraceIds: partial.sourceTraceIds ?? [],
    decisionGuidance: partial.decisionGuidance ?? { preference: [], antiPattern: [] },
    vec: partial.vec ?? vec([1, 0, 0]),
    updatedAt: partial.updatedAt ?? NOW,
  };
}

function makeRepo(
  rows: PolicyRow[],
  hits: {
    vector?: Array<{ id: string; score: number }>;
    text?: Array<{ id: string; score: number }>;
    pattern?: Array<{ id: string; score: number }>;
  },
): RetrievalRepos["policies"] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    searchByVector(_query, k) {
      return (hits.vector ?? []).slice(0, k).map((hit) => ({
        id: hit.id,
        score: hit.score,
        meta: {
          title: byId.get(hit.id)?.title ?? hit.id,
          status: byId.get(hit.id)?.status ?? "active",
          support: byId.get(hit.id)?.support ?? 1,
          gain: byId.get(hit.id)?.gain ?? 0,
        },
      }));
    },
    searchByText(_query, k) {
      return (hits.text ?? []).slice(0, k).map((hit) => ({
        id: hit.id,
        score: hit.score,
      }));
    },
    searchByPattern(_terms, k) {
      return (hits.pattern ?? []).slice(0, k).map((hit) => ({
        id: hit.id,
        score: hit.score,
      }));
    },
    list() {
      return rows;
    },
    getById(id) {
      return byId.get(id) ?? null;
    },
  };
}

describe("retrieval/tier2-experience", () => {
  it("recalls executable experiences without sourceFeedbackIds", async () => {
    const row = makePolicy("po_no_feedback", { sourceFeedbackIds: [] });
    const out = await runTier2Experience(
      { repos: { policies: makeRepo([row], { text: [{ id: row.id, score: 1 }] }) }, config: cfg },
      { queryVec: null, ftsMatch: "SEC 13F" },
    );

    expect(out.map((c) => String(c.refId))).toEqual(["po_no_feedback"]);
    expect(out[0]?.sourceFeedbackIds).toEqual([]);
  });

  it("drops title-only and verification-only experiences as non-executable", async () => {
    const titleOnly = makePolicy("po_title_only", {
      title: "looks relevant",
      trigger: "",
      procedure: "",
      verification: "",
      sourceFeedbackIds: [],
    });
    const verificationOnly = makePolicy("po_check_only", {
      title: "",
      trigger: "",
      procedure: "",
      verification: "check something",
      sourceFeedbackIds: [],
    });
    const runnable = makePolicy("po_runnable", {
      trigger: "when parsing SEC 13F",
      procedure: "",
      sourceFeedbackIds: [],
    });
    const out = await runTier2Experience(
      {
        repos: {
          policies: makeRepo([titleOnly, verificationOnly, runnable], {
            text: [
              { id: titleOnly.id, score: 1 },
              { id: verificationOnly.id, score: 0.9 },
              { id: runnable.id, score: 0.8 },
            ],
          }),
        },
        config: cfg,
      },
      { queryVec: null, ftsMatch: "SEC 13F" },
    );

    expect(out.map((c) => String(c.refId))).toEqual(["po_runnable"]);
  });

  it("keeps a bounded keyword-only supplement when vector hits fill the pool", async () => {
    const vectorRows = Array.from({ length: 6 }, (_, i) =>
      makePolicy(`po_vec_${i}`, {
        trigger: `vector trigger ${i}`,
        procedure: "vector procedure",
        vec: vec([1, 0, 0]),
      }),
    );
    const keywordRows = Array.from({ length: 20 }, (_, i) =>
      makePolicy(`po_kw_${i}`, {
        trigger: `keyword trigger ${i}`,
        procedure: "keyword procedure",
        sourceFeedbackIds: [],
        vec: null,
      }),
    );
    const out = await runTier2Experience(
      {
        repos: {
          policies: makeRepo([...vectorRows, ...keywordRows], {
            vector: vectorRows.map((row, i) => ({ id: row.id, score: 0.9 - i * 0.01 })),
            text: keywordRows.map((row, i) => ({ id: row.id, score: 1 - i * 0.01 })),
          }),
        },
        config: cfg,
      },
      { queryVec: vec([1, 0, 0]), ftsMatch: "keyword" },
    );

    const keywordOnly = out.filter((c) =>
      c.channels.some((ch) => ch.channel === "fts") &&
      !c.channels.some((ch) => ch.channel === "vec"),
    );
    expect(out.length).toBeLessThanOrEqual(9);
    expect(keywordOnly.map((c) => String(c.refId))).toEqual([
      "po_kw_0",
      "po_kw_1",
      "po_kw_2",
    ]);
  });

  it("uses policy title+trigger FTS instead of body-wide policy FTS", async () => {
    const titleHit = makePolicy("po_title_hit", {
      title: "Fix routing regression by tightening conditional logic",
      trigger: "when the task asks for a routing regression fix",
      procedure: "Inspect the failing regression and add a targeted test.",
      sourceFeedbackIds: [],
      vec: null,
    });
    const bodyOnlyHit = makePolicy("po_body_noise", {
      title: "Unrelated policy",
      trigger: "when editing unrelated files",
      procedure: "Fix routing regression by tightening conditional logic",
      sourceFeedbackIds: [],
      vec: null,
    });
    const repo = makeRepo([titleHit, bodyOnlyHit], {
      text: [{ id: bodyOnlyHit.id, score: 1 }],
    }) as RetrievalRepos["policies"] & {
      searchTitleTriggerByText: NonNullable<RetrievalRepos["policies"]>["searchByText"];
    };
    repo.searchTitleTriggerByText = (_query, k) =>
      [{ id: titleHit.id, score: 1 }].slice(0, k);

    const out = await runTier2Experience(
      { repos: { policies: repo }, config: cfg },
      { queryVec: null, ftsMatch: "Fix routing regression" },
    );

    expect(out.map((c) => String(c.refId))).toEqual(["po_title_hit"]);
    expect(out[0]?.channels).toEqual([{ channel: "fts", rank: 0, score: 1 }]);
  });
});
