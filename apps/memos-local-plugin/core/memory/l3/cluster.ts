/**
 * Step 1 of the L3 pipeline — **cluster compatible L2 policies**.
 *
 * V7 §2.4.1 says L3 is induced when "multiple policies behind the scenes
 * share the same organising principle". We don't have labels for that
 * principle; we approximate it with two cheap signals:
 *
 *   1. **Domain key**. A stable short string built from the policy's
 *      primary tag (from `policy.trigger` / `procedure`) plus a
 *      normalised tool family. Example: `"docker|pip"`, `"node|npm"`.
 *      Policies that share the same key go into the same bucket.
 *   2. **Vector proximity**. Within a bucket, we compute pairwise
 *      cosine and only keep policies within `clusterMinSimilarity`
 *      of the bucket centroid. Stragglers become their own buckets
 *      (they'll wait for more evidence).
 *
 * No LLM call happens here — this is pure extraction + math.
 */

import { cosine } from "../../storage/vector.js";
import type { EmbeddingVector, PolicyRow } from "../../types.js";
import { centroid } from "../l2/similarity.js";
import type { L3Config, PolicyCluster, PolicyClusterKey } from "./types.js";

export interface ClusterInput {
  policies: readonly PolicyRow[];
}

export interface ClusterDeps {
  config: Pick<L3Config, "clusterMinSimilarity" | "minPolicies">;
}

// ─── Domain key extraction ─────────────────────────────────────────────────

const TAG_REGEXES: Array<{ re: RegExp; tag: string }> = [
  { re: /\bdocker|\bcontainer|\bpodman\b/i, tag: "docker" },
  { re: /\balpine|musl\b/i, tag: "alpine" },
  { re: /\bnode\.?js?|\bnpm\b|\byarn\b|\bpnpm\b/i, tag: "node" },
  { re: /\bpython\b|\bpip\b|\bpoetry\b|\bconda\b/i, tag: "python" },
  { re: /\brust\b|\bcargo\b/i, tag: "rust" },
  { re: /\bgolang?\b/i, tag: "go" },
  { re: /\bjava\b|\bmaven\b|\bgradle\b/i, tag: "java" },
  { re: /\bpostgres|\bmysql|\bsqlite|\bredis/i, tag: "db" },
  { re: /\b(?:sec\s*13f|13f|cusip|infotable|holdings?|accession|issuer|aum)\b/i, tag: "sec13f" },
  { re: /\bnetwork|\bdns\b|\bproxy\b|\btls\b|\bhttps?\b/i, tag: "network" },
  { re: /\bgit\b|\bgithub\b|\bgitlab\b/i, tag: "git" },
  { re: /\bkubernetes|\bk8s\b|\bhelm\b/i, tag: "k8s" },
  { re: /\baws\b|\bgcp\b|\bazure\b/i, tag: "cloud" },
];

const TOOL_REGEXES: Array<{ re: RegExp; tag: string }> = [
  { re: /\bpip install|\bpip3\b/i, tag: "pip" },
  { re: /\bnpm (?:install|i|publish)\b/i, tag: "npm" },
  { re: /\byarn install\b/i, tag: "yarn" },
  { re: /\bcargo install\b|\bcargo build\b/i, tag: "cargo" },
  { re: /\bapt(?:-get)? install|\bapk add|\byum install/i, tag: "sysdep" },
  { re: /\bdocker build|\bdocker run\b/i, tag: "docker-cli" },
  { re: /\bgit (?:clone|push|pull|checkout)\b/i, tag: "git-cli" },
  { re: /\b(?:sec-api|edgar|filing|xml|csv|parser)\b/i, tag: "sec-tooling" },
];

export function domainKeyOf(policy: PolicyRow): { key: PolicyClusterKey; tags: string[] } {
  const haystack = [policy.title, policy.trigger, policy.procedure, policy.boundary]
    .filter(Boolean)
    .join(" \n ");

  const tags = new Set<string>();
  let primary = "_";
  let tool = "_";

  for (const { re, tag } of TAG_REGEXES) {
    if (re.test(haystack)) {
      tags.add(tag);
      if (primary === "_") primary = tag;
    }
  }
  for (const { re, tag } of TOOL_REGEXES) {
    if (re.test(haystack)) {
      tags.add(tag);
      if (tool === "_") tool = tag;
    }
  }

  return {
    key: `${primary}|${tool}`,
    tags: Array.from(tags),
  };
}

// ─── Clustering ────────────────────────────────────────────────────────────

interface PolicyWithMeta {
  policy: PolicyRow;
  tags: string[];
  key: PolicyClusterKey;
}

/**
 * Split a set of eligible L2 policies into compatible clusters ready for
 * abstraction. Caller is expected to have already filtered by `gain`,
 * `support`, and `status === 'active'` — cluster-time logic doesn't
 * second-guess eligibility.
 */
export function clusterPolicies(
  input: ClusterInput,
  deps: ClusterDeps,
): PolicyCluster[] {
  const { config } = deps;
  if (input.policies.length === 0) return [];

  const withMeta: PolicyWithMeta[] = input.policies.map((p) => {
    const { key, tags } = domainKeyOf(p);
    return { policy: p, tags, key };
  });

  const byKey = new Map<PolicyClusterKey, PolicyWithMeta[]>();
  for (const p of withMeta) {
    if (!byKey.has(p.key)) byKey.set(p.key, []);
    byKey.get(p.key)!.push(p);
  }

  const out: PolicyCluster[] = [];
  for (const [key, members] of byKey) {
    if (members.length < config.minPolicies) continue;

    const vecs: Array<EmbeddingVector | null> = members.map((m) => m.policy.vec ?? null);
    const center = centroid(vecs);

    // Compute strict-admit subset (cosine ≥ clusterMinSimilarity) AND
    // the cohesion score (mean cosine to centroid across ALL members)
    // in one pass — cohesion is reported on the cluster regardless of
    // which admission mode wins so downstream confidence shaping has
    // something to work with.
    const strict: PolicyWithMeta[] = [];
    let cosineSum = 0;
    let cosineCount = 0;
    if (center) {
      for (const m of members) {
        if (!m.policy.vec) {
          // Members without an embedding vector pass through both modes
          // — they have nothing to compare. They still consume an
          // admission slot but contribute 0 to cohesion.
          strict.push(m);
          continue;
        }
        const c = cosine(center, m.policy.vec);
        cosineSum += c;
        cosineCount += 1;
        if (c >= config.clusterMinSimilarity) strict.push(m);
      }
    } else {
      // No centroid (none of the members had a vec). Trust the bucket;
      // every member passes by default.
      strict.push(...members);
    }
    const cohesion = cosineCount > 0 ? cosineSum / cosineCount : 0;

    // V7 §2.4.1 originally formed clusters strictly by cosine. In
    // practice that drops too many bucket-level groups whose LLM-
    // generated policy titles span related sub-problems (e.g. "validate
    // python syntax" and "register CLI subcommand" both live under the
    // `python|_` domain key but their titles embed far apart). Two-stage
    // admission:
    //
    //   1. PREFER the strict cosine subset when it is itself ≥ minPolicies
    //      — this gives the cleanest, most-interpretable L3 abstractions.
    //   2. Otherwise, FALL BACK to the entire domain-key bucket marked
    //      as `admission: "loose"`. The cohesion score travels with the
    //      cluster so `abstract.ts` can dampen its persisted confidence
    //      and widen the abstraction prompt's expected scope.
    //
    // We never accept clusters smaller than `minPolicies`; the choice
    // here is only "strict subset" vs "whole bucket".
    let cohort: PolicyWithMeta[];
    let admission: "strict" | "loose";
    if (strict.length >= config.minPolicies) {
      cohort = strict;
      admission = "strict";
    } else if (members.length >= config.minPolicies) {
      cohort = members;
      admission = "loose";
    } else {
      continue;
    }

    const tags = new Set<string>();
    for (const m of cohort) for (const t of m.tags) tags.add(t);

    const avgGain =
      cohort.reduce((s, m) => s + m.policy.gain, 0) / Math.max(1, cohort.length);

    out.push({
      key,
      policies: cohort.map((m) => m.policy),
      domainTags: Array.from(tags),
      centroidVec: center,
      avgGain,
      cohesion,
      admission,
    });
  }

  // Order clusters by gain × cohesion so strict, high-gain clusters
  // surface first; loose clusters still ship but get last claim on
  // any LLM budget the abstraction stage might be rate-limiting.
  out.sort((a, b) => {
    const aw = a.avgGain * (0.5 + 0.5 * a.cohesion);
    const bw = b.avgGain * (0.5 + 0.5 * b.cohesion);
    if (bw !== aw) return bw - aw;
    return b.policies.length - a.policies.length;
  });
  return out;
}
