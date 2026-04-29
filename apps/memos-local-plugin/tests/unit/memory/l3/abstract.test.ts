/**
 * Unit tests for `core/memory/l3/abstract`:
 *   - happy path → ok + draft with normalised tags + triple
 *   - LLM disabled → llm_disabled
 *   - LLM throws    → llm_failed (no uncaught throw)
 *   - malformed JSON (missing environment[]) → llm_failed
 */

import { describe, expect, it } from "vitest";

import {
  abstractDraft,
  buildWorldModelRow,
} from "../../../../core/memory/l3/abstract.js";
import { L3_ABSTRACTION_PROMPT } from "../../../../core/llm/prompts/l3-abstraction.js";
import type { L3Config, PolicyCluster } from "../../../../core/memory/l3/types.js";
import { rootLogger } from "../../../../core/logger/index.js";
import type {
  EpisodeId,
  PolicyId,
  PolicyRow,
} from "../../../../core/types.js";
import { fakeLlm, throwingLlm } from "../../../helpers/fake-llm.js";
import { NOW, vec } from "./_helpers.js";

const log = rootLogger.child({ channel: "core.memory.l3.abstract" });

function cfg(overrides: Partial<L3Config> = {}): L3Config {
  return {
    minPolicies: 3,
    minPolicyGain: 0.1,
    minPolicySupport: 2,
    clusterMinSimilarity: 0.6,
    policyCharCap: 400,
    traceCharCap: 300,
    traceEvidencePerPolicy: 1,
    useLlm: true,
    cooldownDays: 0,
    confidenceDelta: 0.05,
    minConfidenceForRetrieval: 0.2,
    ...overrides,
  };
}

function mkPolicy(partial: Partial<PolicyRow> & { id: PolicyId }): PolicyRow {
  return {
    id: partial.id,
    title: partial.title ?? "untitled",
    trigger: partial.trigger ?? "",
    procedure: partial.procedure ?? "",
    verification: partial.verification ?? "",
    boundary: partial.boundary ?? "",
    support: partial.support ?? 5,
    gain: partial.gain ?? 0.3,
    status: partial.status ?? "active",
    sourceEpisodeIds: partial.sourceEpisodeIds ?? [],
    inducedBy: partial.inducedBy ?? "test",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: partial.vec ?? vec([1, 0, 0]),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function mkCluster(): PolicyCluster {
  return {
    key: "docker|pip",
    policies: [
      mkPolicy({ id: "po_1" as PolicyId, title: "alpine pip retry" }),
      mkPolicy({ id: "po_2" as PolicyId, title: "no-binary pip" }),
      mkPolicy({ id: "po_3" as PolicyId, title: "apk deps before pip" }),
    ],
    domainTags: ["docker", "alpine", "pip"],
    centroidVec: vec([1, 0, 0]),
    avgGain: 0.3,
    cohesion: 1,
    admission: "strict",
  };
}

const OP = `${L3_ABSTRACTION_PROMPT.id}.v${L3_ABSTRACTION_PROMPT.version}`;

describe("memory/l3/abstract", () => {
  it("returns {ok:true, draft} with normalised tags + triple", async () => {
    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: "Alpine python dependency model",
          domain_tags: ["Alpine", "python", "  pip  ", ""],
          environment: [
            { label: "Alpine", description: "uses musl libc" },
          ],
          inference: [
            { label: "Binary wheels fail", description: "musl incompatible", evidenceIds: ["po_1"] },
          ],
          constraints: [
            { label: "No pre-built wheels", description: "avoid binary on alpine" },
          ],
          body: "markdown summary",
          confidence: 0.7,
          supersedes_world_ids: [],
        },
      },
    });

    const res = await abstractDraft(
      { cluster: mkCluster(), evidenceByPolicy: new Map() },
      { llm, log, config: cfg() },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.title).toBe("Alpine python dependency model");
    expect(res.draft.domainTags).toEqual(["alpine", "python", "pip"]);
    expect(res.draft.environment).toHaveLength(1);
    expect(res.draft.inference[0]!.evidenceIds).toEqual(["po_1"]);
    expect(res.draft.confidence).toBeCloseTo(0.7, 5);
  });

  it("returns llm_disabled when useLlm is off", async () => {
    const res = await abstractDraft(
      { cluster: mkCluster(), evidenceByPolicy: new Map() },
      { llm: fakeLlm(), log, config: cfg({ useLlm: false }) },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("llm_disabled");
  });

  it("returns llm_failed when the LLM throws — never rethrows", async () => {
    const llm = throwingLlm(new Error("boom"));
    const res = await abstractDraft(
      { cluster: mkCluster(), evidenceByPolicy: new Map() },
      { llm, log, config: cfg() },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("llm_failed");
    expect(res.detail).toContain("boom");
  });

  it("returns llm_failed when the LLM returns missing triple", async () => {
    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: "missing triple",
          // no environment / inference / constraints
        },
      },
    });
    const res = await abstractDraft(
      { cluster: mkCluster(), evidenceByPolicy: new Map() },
      { llm, log, config: cfg() },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("llm_failed");
    expect(res.detail ?? "").toMatch(/environment|inference|constraints/);
  });

  it("buildWorldModelRow wires draft + cluster into a persist-ready row", () => {
    const cluster = mkCluster();
    const row = buildWorldModelRow({
      draft: {
        title: "Alpine python deps",
        domainTags: ["alpine", "python"],
        environment: [{ label: "musl", description: "no glibc" }],
        inference: [],
        constraints: [],
        body: "",
        confidence: 0.8,
      },
      cluster,
      episodeIds: ["ep_a", "ep_b", "ep_a"] as EpisodeId[],
      inducedBy: OP,
      now: NOW,
      id: "wm_test" as Parameters<typeof buildWorldModelRow>[0]["id"],
    });

    expect(row.id).toBe("wm_test");
    expect(row.title).toBe("Alpine python deps");
    expect(row.domainTags).toEqual(["alpine", "python"]);
    expect(row.policyIds.length).toBe(3);
    expect(row.sourceEpisodeIds).toEqual(["ep_a", "ep_b"]);
    expect(row.confidence).toBeCloseTo(0.8, 5);
    expect(row.body).toContain("Environment");
  });
});

