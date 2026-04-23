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

    const kept: PolicyWithMeta[] = [];
    if (center) {
      for (const m of members) {
        if (!m.policy.vec) {
          kept.push(m);
          continue;
        }
        const c = cosine(center, m.policy.vec);
        if (c >= config.clusterMinSimilarity) kept.push(m);
      }
    } else {
      kept.push(...members);
    }

    if (kept.length < config.minPolicies) continue;

    const tags = new Set<string>();
    for (const m of kept) for (const t of m.tags) tags.add(t);

    const avgGain =
      kept.reduce((s, m) => s + m.policy.gain, 0) / Math.max(1, kept.length);

    out.push({
      key,
      policies: kept.map((m) => m.policy),
      domainTags: Array.from(tags),
      centroidVec: center,
      avgGain,
    });
  }

  out.sort((a, b) => b.avgGain - a.avgGain || b.policies.length - a.policies.length);
  return out;
}
