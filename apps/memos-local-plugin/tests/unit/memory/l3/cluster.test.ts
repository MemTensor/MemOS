/**
 * Unit tests for `core/memory/l3/cluster`.
 *
 * Covers:
 *   - domain key extraction from policy text
 *   - bucketing + centroid-based filtering
 *   - minPolicies gating
 */

import { describe, expect, it } from "vitest";

import {
  clusterPolicies,
  domainKeyOf,
} from "../../../../core/memory/l3/cluster.js";
import type { PolicyId, PolicyRow } from "../../../../core/types.js";
import { NOW, vec } from "./_helpers.js";

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

describe("memory/l3/cluster", () => {
  describe("domainKeyOf", () => {
    it("recognises docker + pip in policy text", () => {
      const p = mkPolicy({
        id: "po_1" as PolicyId,
        title: "install system libs first",
        trigger: "pip install fails in Alpine container",
        procedure: "apk add then pip install",
      });
      const { key, tags } = domainKeyOf(p);
      expect(key).toContain("docker");
      expect(key).toContain("pip");
      expect(tags).toEqual(expect.arrayContaining(["docker", "alpine", "pip"]));
    });

    it("falls back to _|_ when nothing matches", () => {
      const p = mkPolicy({
        id: "po_x" as PolicyId,
        title: "abstract planning heuristic",
      });
      const { key, tags } = domainKeyOf(p);
      expect(key).toBe("_|_");
      expect(tags).toEqual([]);
    });

    it("groups network-related text under 'network'", () => {
      const p = mkPolicy({
        id: "po_n" as PolicyId,
        title: "retry with proxy when DNS fails",
        procedure: "Detect ENOTFOUND → set HTTP_PROXY → retry",
      });
      const { tags } = domainKeyOf(p);
      expect(tags).toContain("network");
    });
  });

  describe("clusterPolicies", () => {
    it("groups similar policies into one bucket", () => {
      const policies = [
        mkPolicy({
          id: "po_1" as PolicyId,
          title: "install system libs first",
          trigger: "pip install fails in Alpine",
          procedure: "apk add then pip install",
          vec: vec([1, 0, 0]),
        }),
        mkPolicy({
          id: "po_2" as PolicyId,
          title: "use --no-binary for pip",
          trigger: "pip install fails on musl",
          procedure: "pip install --no-binary :all: then apk add",
          vec: vec([0.9, 0.1, 0]),
        }),
        mkPolicy({
          id: "po_3" as PolicyId,
          title: "alpine pip fallback",
          trigger: "pip install wheel fails because musl",
          procedure: "pip install -vv, parse missing lib, apk add",
          vec: vec([0.95, 0.05, 0]),
        }),
      ];
      const clusters = clusterPolicies(
        { policies },
        { config: { clusterMinSimilarity: 0.6, minPolicies: 3 } },
      );
      expect(clusters.length).toBe(1);
      expect(clusters[0]!.policies.length).toBe(3);
      expect(clusters[0]!.domainTags).toEqual(
        expect.arrayContaining(["alpine", "pip"]),
      );
    });

    it("skips a bucket that doesn't meet minPolicies", () => {
      const policies = [
        mkPolicy({
          id: "po_a" as PolicyId,
          title: "pip install fix",
          procedure: "pip install",
          vec: vec([1, 0, 0]),
        }),
        mkPolicy({
          id: "po_b" as PolicyId,
          title: "pip install fix 2",
          procedure: "pip install",
          vec: vec([0.9, 0.1, 0]),
        }),
      ];
      const clusters = clusterPolicies(
        { policies },
        { config: { clusterMinSimilarity: 0.6, minPolicies: 3 } },
      );
      expect(clusters).toEqual([]);
    });

    it("splits two obviously-different domains into separate buckets", () => {
      const policies = [
        // docker + pip family (3)
        mkPolicy({
          id: "po_1" as PolicyId,
          title: "pip in docker fix",
          procedure: "pip install in docker",
          vec: vec([1, 0, 0]),
        }),
        mkPolicy({
          id: "po_2" as PolicyId,
          title: "pip in docker alpine",
          procedure: "apk add then pip install",
          vec: vec([0.95, 0.05, 0]),
        }),
        mkPolicy({
          id: "po_3" as PolicyId,
          title: "pip fails in alpine container",
          procedure: "apk add + pip install",
          vec: vec([0.9, 0.1, 0]),
        }),
        // npm family (3)
        mkPolicy({
          id: "po_4" as PolicyId,
          title: "fix npm publish",
          trigger: "npm publish rejects scope",
          procedure: "set publishConfig in package.json",
          vec: vec([0, 1, 0]),
        }),
        mkPolicy({
          id: "po_5" as PolicyId,
          title: "npm install conflict",
          trigger: "npm install fails for workspace",
          procedure: "yarn install instead",
          vec: vec([0, 0.95, 0.05]),
        }),
        mkPolicy({
          id: "po_6" as PolicyId,
          title: "npm lockfile mismatch",
          trigger: "npm install ENOLOCK",
          procedure: "rm package-lock.json; npm install",
          vec: vec([0, 0.9, 0.1]),
        }),
      ];
      const clusters = clusterPolicies(
        { policies },
        { config: { clusterMinSimilarity: 0.6, minPolicies: 3 } },
      );
      const keys = clusters.map((c) => c.key).sort();
      expect(keys.length).toBe(2);
      expect(keys.some((k) => k.includes("docker"))).toBe(true);
      expect(keys.some((k) => k.includes("node") || k.includes("npm"))).toBe(true);
    });

    it("falls back to loose admission when strict subset is too small but bucket survives", () => {
      // All three policies share the same domain key (`python|_`) but
      // their vectors point in mutually-orthogonal directions, so the
      // strict (cosine ≥ minSimilarity) subset would be empty. The
      // bucket itself satisfies minPolicies, so `cluster.ts` should
      // fall back to admitting the WHOLE bucket as a `loose` cluster.
      const policies = [
        mkPolicy({
          id: "po_validate" as PolicyId,
          title: "validate python syntax",
          trigger: "after writing python files",
          procedure: "python -m py_compile <file>",
          vec: vec([1, 0, 0]),
        }),
        mkPolicy({
          id: "po_cli" as PolicyId,
          title: "register python CLI subcommand",
          trigger: "adding a new task verb",
          procedure: "register(subparsers) + handler() -> int",
          vec: vec([0, 1, 0]),
        }),
        mkPolicy({
          id: "po_storage" as PolicyId,
          title: "implement python storage backend",
          trigger: "new persistence format requested",
          procedure: "implement load/save with UTF-8",
          vec: vec([0, 0, 1]),
        }),
      ];
      const clusters = clusterPolicies(
        { policies },
        { config: { clusterMinSimilarity: 0.6, minPolicies: 2 } },
      );
      expect(clusters.length).toBe(1);
      const c = clusters[0]!;
      expect(c.admission).toBe("loose");
      expect(c.policies.length).toBe(3);
      // Centroid of three orthogonal unit vectors gives mean cosine
      // 1/sqrt(3) ≈ 0.577 — strictly less than 0.6 (the strict floor),
      // confirming we landed in the loose fallback for the right
      // reason and not because of a bug elsewhere.
      expect(c.cohesion).toBeLessThan(0.6);
      expect(c.cohesion).toBeGreaterThan(0.5);
    });

    it("filters outliers below clusterMinSimilarity", () => {
      const policies = [
        mkPolicy({
          id: "po_1" as PolicyId,
          title: "pip install in docker alpine",
          trigger: "pip in docker fails",
          procedure: "apk add then pip",
          vec: vec([1, 0, 0]),
        }),
        mkPolicy({
          id: "po_2" as PolicyId,
          title: "pip install in docker alpine 2",
          trigger: "pip in docker fails alpine",
          procedure: "apk add then pip",
          vec: vec([0.9, 0.1, 0]),
        }),
        mkPolicy({
          id: "po_3" as PolicyId,
          title: "pip install in docker alpine 3",
          trigger: "pip fails in alpine container",
          procedure: "apk add then pip install",
          vec: vec([0.95, 0.05, 0]),
        }),
        mkPolicy({
          id: "po_outlier" as PolicyId,
          title: "pip install elsewhere",
          trigger: "pip in docker",
          procedure: "pip install in docker",
          vec: vec([-1, 0, 0]),
        }),
      ];
      const clusters = clusterPolicies(
        { policies },
        { config: { clusterMinSimilarity: 0.6, minPolicies: 3 } },
      );
      expect(clusters.length).toBe(1);
      const c = clusters[0]!;
      // The strict subset (3 normals, all cosine ≥ 0.6) is itself
      // ≥ minPolicies, so we should land in `strict` admission and
      // the outlier must be excluded — not folded back via the loose
      // fallback.
      expect(c.admission).toBe("strict");
      expect(c.policies.map((p) => String(p.id))).not.toContain("po_outlier");
      expect(c.cohesion).toBeGreaterThan(0.5);
    });
  });
});
