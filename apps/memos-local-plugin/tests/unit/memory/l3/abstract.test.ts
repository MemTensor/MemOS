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

  it("cleans unsafe markup from LLM-derived world model fields", async () => {
    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: "<img src=x onerror=alert(1)> Alpine model",
          domain_tags: ["Alpine"],
          environment: [
            {
              label: "<b>Runtime</b>",
              description: "<script>alert(1)</script>Use [docs](javascript:alert(1)) safely",
            },
          ],
          inference: [],
          constraints: [],
          body: "<script>alert(1)</script>See [safe](https://example.com) and [bad](javascript:alert(1))",
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
    const combined = [
      res.draft.title,
      res.draft.body,
      ...res.draft.environment.flatMap((e) => [e.label, e.description]),
    ].join("\n");
    expect(combined).not.toMatch(/<script|<img|<b>|javascript:/i);
    expect(res.draft.title).toBe("Alpine model");
    expect(res.draft.environment[0]!.label).toBe("Runtime");
    expect(res.draft.environment[0]!.description).toContain("Use docs safely");
    expect(res.draft.body).toContain("[safe](https://example.com)");
    expect(res.draft.body).toContain("bad");
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

  it("salvages missing triple into an empty-but-titled draft instead of failing", async () => {
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
    // Issue #1668: rather than aborting, the parser now returns a salvaged
    // draft. The title alone is enough to keep the entry alive; downstream
    // validators decide whether the (empty) facets are good enough to
    // persist.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.title).toBe("missing triple");
    expect(res.draft.environment).toEqual([]);
    expect(res.draft.inference).toEqual([]);
    expect(res.draft.constraints).toEqual([]);
  });

  it("returns llm_failed only when even normalisation can't recover anything", async () => {
    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          // no title, no triple, no body, no domain tags — truly empty.
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
    expect(res.detail ?? "").toMatch(/empty after normalization/);
  });

  it("salvages string list entries into description-only entries (issue #1668)", async () => {
    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: "alpine",
          domain_tags: ["alpine"],
          environment: ["runs on musl libc"],
          inference: ["binary wheels miss glibc"],
          constraints: ["avoid binary install"],
          confidence: 0.5,
        },
      },
    });
    const res = await abstractDraft(
      { cluster: mkCluster(), evidenceByPolicy: new Map() },
      { llm, log, config: cfg() },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.environment).toEqual([
      { label: "", description: "runs on musl libc" },
    ]);
    expect(res.draft.inference[0]!.description).toBe("binary wheels miss glibc");
    expect(res.draft.constraints[0]!.description).toBe("avoid binary install");
  });

  it("salvages {body: ...} list entries to canonical {label, description}", async () => {
    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: "alpine",
          domain_tags: ["alpine"],
          environment: [{ label: "musl", body: "no glibc available" }],
          inference: [{ body: "wheels need glibc" }],
          constraints: [{ name: "no-binary", text: "pip install --no-binary" }],
          confidence: 0.5,
        },
      },
    });
    const res = await abstractDraft(
      { cluster: mkCluster(), evidenceByPolicy: new Map() },
      { llm, log, config: cfg() },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.environment).toEqual([
      { label: "musl", description: "no glibc available" },
    ]);
    expect(res.draft.inference[0]).toEqual({
      label: "",
      description: "wheels need glibc",
    });
    expect(res.draft.constraints[0]).toEqual({
      label: "no-binary",
      description: "pip install --no-binary",
    });
  });

  it("derives a title from inference when the LLM left it blank (issue #1668)", async () => {
    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: "   ",
          domain_tags: ["alpine", "pip"],
          environment: [],
          inference: [{ label: "Binary wheels fail on alpine", description: "musl" }],
          constraints: [],
          confidence: 0.5,
        },
      },
    });
    const res = await abstractDraft(
      { cluster: mkCluster(), evidenceByPolicy: new Map() },
      { llm, log, config: cfg() },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.title).toBe("Binary wheels fail on alpine");
  });

  it("falls back to domain tags when title and triple are unhelpful", async () => {
    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: null,
          domain_tags: ["docker", "alpine", "pip"],
          environment: [],
          inference: [],
          constraints: [],
          body: "",
          confidence: 0.4,
        },
      },
    });
    const res = await abstractDraft(
      { cluster: mkCluster(), evidenceByPolicy: new Map() },
      { llm, log, config: cfg() },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.title).toBe("docker, alpine, pip");
  });

  it("splits a comma-joined domain_tags string into an array (issue #1668)", async () => {
    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: "alpine",
          domain_tags: "Alpine, Python, pip,  ",
          environment: [{ label: "musl", description: "x" }],
          inference: [],
          constraints: [],
          confidence: 0.5,
        },
      },
    });
    const res = await abstractDraft(
      { cluster: mkCluster(), evidenceByPolicy: new Map() },
      { llm, log, config: cfg() },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.domainTags).toEqual(["alpine", "python", "pip"]);
  });

  it("trims and drops empty evidence ids from array entries", async () => {
    const llm = fakeLlm({
      completeJson: {
        [OP]: {
          title: "alpine",
          domain_tags: ["alpine"],
          environment: [
            {
              label: "musl",
              description: "x",
              // Provider returned strings with leading/trailing whitespace
              // and an empty entry; the UI evidence chip classifier relies
              // on `id.startsWith("po_")` so trimming is required.
              evidenceIds: ["po_1 ", " tr_2", "", "   "],
            },
          ],
          inference: [],
          constraints: [],
          confidence: 0.5,
        },
      },
    });
    const res = await abstractDraft(
      { cluster: mkCluster(), evidenceByPolicy: new Map() },
      { llm, log, config: cfg() },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.environment[0]!.evidenceIds).toEqual(["po_1", "tr_2"]);
  });

  it("renders string-only entries without an empty bold label in body", () => {
    const cluster = mkCluster();
    const row = buildWorldModelRow({
      draft: {
        title: "Alpine python deps",
        domainTags: ["alpine"],
        environment: [
          { label: "musl", description: "no glibc" },
          { label: "", description: "runs on musl libc" },
        ],
        inference: [{ label: "", description: "binary wheels miss glibc" }],
        constraints: [],
        body: "",
        confidence: 0.5,
      },
      cluster,
      episodeIds: ["ep_a"] as EpisodeId[],
      inducedBy: OP,
      now: NOW,
      id: "wm_test" as Parameters<typeof buildWorldModelRow>[0]["id"],
    });
    expect(row.body).toContain("- **musl** \u2014 no glibc");
    expect(row.body).toContain("- runs on musl libc");
    expect(row.body).toContain("- binary wheels miss glibc");
    expect(row.body).not.toContain("- **** \u2014");
    expect(row.body).not.toMatch(/-\s+\*\*\s*\*\*/);
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

