/**
 * Unit tests for `core/memory/l3/merge`:
 *   - chooseMergeTarget picks an existing WM above similarity cutoff
 *   - explicit `supersedesWorldIds` wins regardless of cosine
 *   - mergeForUpdate unions structure entries + dedupes ids + clamps tags
 */

import { describe, expect, it } from "vitest";

import {
  chooseMergeTarget,
  gatherMergeCandidates,
  mergeForUpdate,
} from "../../../../core/memory/l3/merge.js";
import type {
  L3AbstractionDraft,
  PolicyCluster,
} from "../../../../core/memory/l3/types.js";
import type {
  PolicyId,
  WorldModelId,
  WorldModelRow,
  WorldModelStructure,
} from "../../../../core/types.js";
import { NOW, vec } from "./_helpers.js";

const STRUCTURE_EMPTY: WorldModelStructure = {
  environment: [],
  inference: [],
  constraints: [],
};

function mkWorldModel(partial: Partial<WorldModelRow> & { id: WorldModelId }): WorldModelRow {
  return {
    id: partial.id,
    title: partial.title ?? "t",
    body: partial.body ?? "",
    structure: partial.structure ?? STRUCTURE_EMPTY,
    domainTags: partial.domainTags ?? ["docker"],
    confidence: partial.confidence ?? 0.5,
    policyIds: partial.policyIds ?? [],
    sourceEpisodeIds: partial.sourceEpisodeIds ?? [],
    inducedBy: partial.inducedBy ?? "",
    vec: partial.vec ?? vec([1, 0, 0]),
    createdAt: NOW,
    updatedAt: NOW,
    version: partial.version ?? 1,
    status: partial.status ?? "active",
  };
}

function mkCluster(partial: Partial<PolicyCluster> = {}): PolicyCluster {
  return {
    key: partial.key ?? "docker|pip",
    policies: partial.policies ?? [],
    domainTags: partial.domainTags ?? ["docker", "alpine"],
    centroidVec: partial.centroidVec ?? vec([1, 0, 0]),
    avgGain: partial.avgGain ?? 0.3,
    // Default to a tight `strict` admission with full cohesion so the
    // existing merge-tests (which predate the two-stage admission
    // change in cluster.ts) keep their original semantics. Tests that
    // specifically want to exercise the loose / low-cohesion branch
    // can pass them in `partial`.
    cohesion: partial.cohesion ?? 1.0,
    admission: partial.admission ?? "strict",
  };
}

function mkDraft(partial: Partial<L3AbstractionDraft> = {}): L3AbstractionDraft {
  return {
    title: partial.title ?? "t",
    domainTags: partial.domainTags ?? ["docker"],
    environment: partial.environment ?? [],
    inference: partial.inference ?? [],
    constraints: partial.constraints ?? [],
    body: partial.body ?? "",
    confidence: partial.confidence ?? 0.5,
    supersedesWorldIds: partial.supersedesWorldIds,
  };
}

describe("memory/l3/merge", () => {
  it("gatherMergeCandidates dedupes by id across overlapping tags", () => {
    const a = mkWorldModel({
      id: "wm_a" as WorldModelId,
      domainTags: ["docker", "alpine"],
    });
    const b = mkWorldModel({
      id: "wm_b" as WorldModelId,
      domainTags: ["pip"],
    });
    const lookup = {
      findByDomainTag(tag: string): WorldModelRow[] {
        if (tag === "docker") return [a];
        if (tag === "alpine") return [a];
        if (tag === "pip") return [b];
        return [];
      },
    };
    const out = gatherMergeCandidates(
      mkCluster({ domainTags: ["docker", "alpine", "pip"] }),
      { lookup, config: { clusterMinSimilarity: 0.6 } },
    );
    expect(out.map((r) => String(r.id)).sort()).toEqual(["wm_a", "wm_b"]);
  });

  it("chooseMergeTarget picks the closest WM above similarity cutoff", () => {
    const a = mkWorldModel({
      id: "wm_close" as WorldModelId,
      vec: vec([0.95, 0.05, 0]),
    });
    const b = mkWorldModel({
      id: "wm_far" as WorldModelId,
      vec: vec([-1, 0, 0]),
    });
    const out = chooseMergeTarget(
      mkCluster({ centroidVec: vec([1, 0, 0]) }),
      [a, b],
      mkDraft(),
      { lookup: fakeLookup(), config: { clusterMinSimilarity: 0.6 } },
    );
    expect(out.kind).toBe("update");
    if (out.kind !== "update") return;
    expect(String(out.target.id)).toBe("wm_close");
    expect(out.cosineScore).toBeGreaterThan(0.9);
  });

  it("chooseMergeTarget force-merges when policy ids overlap strongly", () => {
    const overlapping = mkWorldModel({
      id: "wm_overlap" as WorldModelId,
      vec: vec([0, 1, 0]),
      policyIds: ["po_a", "po_b", "po_c"] as PolicyId[],
    });
    const far = mkWorldModel({
      id: "wm_far" as WorldModelId,
      vec: vec([1, 0, 0]),
      policyIds: ["po_x", "po_y"] as PolicyId[],
    });
    const out = chooseMergeTarget(
      mkCluster({
        centroidVec: vec([1, 0, 0]),
        policies: [
          { id: "po_a" as PolicyId },
          { id: "po_b" as PolicyId },
          { id: "po_d" as PolicyId },
        ] as PolicyCluster["policies"],
      }),
      [overlapping, far],
      mkDraft(),
      { lookup: fakeLookup(), config: { clusterMinSimilarity: 0.9 } },
    );
    expect(out.kind).toBe("update");
    if (out.kind !== "update") return;
    expect(String(out.target.id)).toBe("wm_overlap");
  });

  it("chooseMergeTarget returns create when nothing passes the cutoff", () => {
    const a = mkWorldModel({
      id: "wm_far" as WorldModelId,
      vec: vec([0, 1, 0]),
    });
    const out = chooseMergeTarget(
      mkCluster({ centroidVec: vec([1, 0, 0]) }),
      [a],
      mkDraft(),
      { lookup: fakeLookup(), config: { clusterMinSimilarity: 0.9 } },
    );
    expect(out.kind).toBe("create");
  });

  it("explicit supersedesWorldIds wins even if cosine is below cutoff", () => {
    const target = mkWorldModel({
      id: "wm_old" as WorldModelId,
      vec: vec([-1, 0, 0]),
    });
    const out = chooseMergeTarget(
      mkCluster({ centroidVec: vec([1, 0, 0]) }),
      [target],
      mkDraft({ supersedesWorldIds: ["wm_old" as WorldModelId] }),
      { lookup: fakeLookup(), config: { clusterMinSimilarity: 0.9 } },
    );
    expect(out.kind).toBe("update");
    if (out.kind !== "update") return;
    expect(String(out.target.id)).toBe("wm_old");
    expect(out.cosineScore).toBe(1);
  });

  it("mergeForUpdate unions structure, dedupes ids, clamps tags", () => {
    const existing = mkWorldModel({
      id: "wm_exist" as WorldModelId,
      structure: {
        environment: [{ label: "musl", description: "no glibc" }],
        inference: [],
        constraints: [],
      },
      domainTags: ["docker", "alpine"],
      policyIds: ["po_1" as PolicyId],
      sourceEpisodeIds: ["ep_a"],
    });
    const draft = mkDraft({
      title: "updated title",
      environment: [
        { label: "musl", description: "no glibc" }, // dup
        { label: "python-dev", description: "build headers required" },
      ],
      inference: [{ label: "pip fails", description: "binary wheels mismatch" }],
      constraints: [],
      domainTags: ["docker", "python"],
      body: "new body",
    });
    const cluster = mkCluster({
      policies: [
        { id: "po_2" as PolicyId } as unknown as PolicyCluster["policies"][number],
        { id: "po_3" as PolicyId } as unknown as PolicyCluster["policies"][number],
      ],
      domainTags: ["docker", "python"],
    });
    const patch = mergeForUpdate({
      existing,
      draft,
      cluster,
      episodeIds: ["ep_a", "ep_b"],
    });

    expect(patch.title).toBe("updated title");
    expect(patch.body).toBe("new body");
    expect(patch.structure.environment.length).toBe(2);
    expect(patch.structure.inference.length).toBe(1);
    expect(patch.domainTags).toEqual(expect.arrayContaining(["docker", "alpine", "python"]));
    expect(patch.policyIds.map(String).sort()).toEqual(["po_1", "po_2", "po_3"]);
    expect(patch.sourceEpisodeIds.sort()).toEqual(["ep_a", "ep_b"]);
    expect(patch.vec).toBe(cluster.centroidVec);
  });
});

function fakeLookup(): { findByDomainTag(tag: string): WorldModelRow[] } {
  return { findByDomainTag: () => [] };
}
