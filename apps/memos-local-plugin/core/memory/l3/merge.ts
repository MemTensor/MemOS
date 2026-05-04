/**
 * L3 upsert / merge logic.
 *
 * Given a freshly-abstracted world-model draft, decide whether to:
 *   1. Create a new row in `world_model`, or
 *   2. Update an existing row in-place (when a similar WM already covers
 *      the same domain), or
 *   3. Retire explicitly superseded WMs (`draft.supersedesWorldIds`).
 *
 * "Similar enough" is defined as a cosine cutoff against a shortlist of
 * WMs that share at least one `domainTag` with the cluster. This avoids
 * spraying near-duplicate world models across runs while still letting
 * genuinely distinct environments coexist (e.g. "Alpine python" vs
 * "Debian python").
 *
 * Pure decisions; no DB writes here. The orchestrator applies the result.
 */

import { cosine } from "../../storage/vector.js";
import type {
  EmbeddingVector,
  PolicyId,
  WorldModelId,
  WorldModelRow,
} from "../../types.js";
import type {
  L3AbstractionDraft,
  L3Config,
  PolicyCluster,
} from "./types.js";

// ─── Candidate gathering ───────────────────────────────────────────────────

export interface MergeCandidateLookup {
  findByDomainTag(tag: string): WorldModelRow[];
  list?(opts?: { limit?: number }): WorldModelRow[];
}

export interface MergeDeps {
  lookup: MergeCandidateLookup;
  config: Pick<L3Config, "clusterMinSimilarity">;
}

const POLICY_OVERLAP_MERGE_THRESHOLD = 0.6;

/**
 * Pull the small shortlist of WMs that might be the "same environment"
 * as the given cluster. De-dupes by id and skips entries with no vector
 * (no vector = nothing we can compare against).
 */
export function gatherMergeCandidates(
  cluster: PolicyCluster,
  deps: MergeDeps,
): WorldModelRow[] {
  const seen = new Map<WorldModelId, WorldModelRow>();
  for (const tag of cluster.domainTags) {
    for (const wm of deps.lookup.findByDomainTag(tag)) {
      if (!seen.has(wm.id)) seen.set(wm.id, wm);
    }
  }
  if (deps.lookup.list) {
    for (const wm of deps.lookup.list({ limit: 5_000 })) {
      if (wm.status === "archived") continue;
      const overlap = policyOverlapScore(cluster.policies.map((p) => p.id), wm.policyIds);
      if (overlap >= POLICY_OVERLAP_MERGE_THRESHOLD && !seen.has(wm.id)) {
        seen.set(wm.id, wm);
      }
    }
  }
  return Array.from(seen.values());
}

// ─── Decision ──────────────────────────────────────────────────────────────

export type MergeDecision =
  | { kind: "create" }
  | { kind: "update"; target: WorldModelRow; cosineScore: number };

/**
 * Pick the closest existing WM that passes the similarity cutoff.
 * If none qualify we return `{kind: "create"}` — the caller will
 * insert a fresh row.
 */
export function chooseMergeTarget(
  cluster: PolicyCluster,
  candidates: readonly WorldModelRow[],
  draft: L3AbstractionDraft,
  deps: MergeDeps,
): MergeDecision {
  const threshold = deps.config.clusterMinSimilarity;

  const explicit = pickBySupersedes(candidates, draft.supersedesWorldIds ?? []);
  if (explicit) {
    return { kind: "update", target: explicit, cosineScore: 1 };
  }

  const policyOverlap = pickByPolicyOverlap(cluster, candidates);
  if (policyOverlap) {
    return {
      kind: "update",
      target: policyOverlap.row,
      cosineScore: policyOverlap.score,
    };
  }

  const clusterVec = cluster.centroidVec;
  if (!clusterVec) return { kind: "create" };

  let best: { row: WorldModelRow; score: number } | null = null;
  for (const wm of candidates) {
    if (!wm.vec) continue;
    const score = cosine(clusterVec as EmbeddingVector, wm.vec);
    if (score >= threshold && (!best || score > best.score)) {
      best = { row: wm, score };
    }
  }

  if (best) return { kind: "update", target: best.row, cosineScore: best.score };
  return { kind: "create" };
}

function pickBySupersedes(
  candidates: readonly WorldModelRow[],
  supersedes: readonly WorldModelId[],
): WorldModelRow | null {
  if (supersedes.length === 0) return null;
  for (const wm of candidates) {
    if (supersedes.includes(wm.id)) return wm;
  }
  return null;
}

function pickByPolicyOverlap(
  cluster: PolicyCluster,
  candidates: readonly WorldModelRow[],
): { row: WorldModelRow; score: number } | null {
  const clusterPolicyIds = cluster.policies.map((p) => p.id);
  let best: { row: WorldModelRow; score: number; shared: number } | null = null;
  for (const wm of candidates) {
    if (wm.status === "archived") continue;
    const score = policyOverlapScore(clusterPolicyIds, wm.policyIds);
    if (score < POLICY_OVERLAP_MERGE_THRESHOLD) continue;
    const shared = sharedPolicyCount(clusterPolicyIds, wm.policyIds);
    if (
      !best ||
      score > best.score ||
      (score === best.score && shared > best.shared) ||
      (score === best.score && shared === best.shared && wm.confidence > best.row.confidence)
    ) {
      best = { row: wm, score, shared };
    }
  }
  return best;
}

function policyOverlapScore(left: readonly PolicyId[], right: readonly PolicyId[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const shared = sharedPolicyCount(left, right);
  return shared / Math.min(left.length, right.length);
}

function sharedPolicyCount(left: readonly PolicyId[], right: readonly PolicyId[]): number {
  const rightSet = new Set(right);
  let shared = 0;
  for (const id of new Set(left)) {
    if (rightSet.has(id)) shared += 1;
  }
  return shared;
}

// ─── Field merging (for "update" decisions) ─────────────────────────────────

export interface MergedPatch {
  title: string;
  body: string;
  structure: {
    environment: Array<{ label: string; description: string; evidenceIds?: string[] }>;
    inference: Array<{ label: string; description: string; evidenceIds?: string[] }>;
    constraints: Array<{ label: string; description: string; evidenceIds?: string[] }>;
  };
  domainTags: string[];
  policyIds: PolicyId[];
  sourceEpisodeIds: string[];
  vec: EmbeddingVector | null;
}

/**
 * Build the patch we hand to `worldModel.updateBody(...)`. We prefer the
 * fresh draft's sections but retain any unique structured entries from
 * the existing row so we don't forget evidence accumulated across runs.
 */
export function mergeForUpdate(args: {
  existing: WorldModelRow;
  draft: L3AbstractionDraft;
  cluster: PolicyCluster;
  episodeIds: readonly string[];
}): MergedPatch {
  const { existing, draft, cluster, episodeIds } = args;

  const env = mergeEntries(existing.structure.environment, draft.environment);
  const inf = mergeEntries(existing.structure.inference, draft.inference);
  const con = mergeEntries(existing.structure.constraints, draft.constraints);

  const domainTags = mergeTags(existing.domainTags, draft.domainTags.length > 0 ? draft.domainTags : cluster.domainTags);
  const policyIds = mergeIds<PolicyId>(
    existing.policyIds,
    cluster.policies.map((p) => p.id),
  );
  const sourceEpisodeIds = mergeIds<string>(existing.sourceEpisodeIds, episodeIds);

  const vec: EmbeddingVector | null =
    (cluster.centroidVec as EmbeddingVector | null) ?? existing.vec ?? null;

  return {
    title: draft.title.slice(0, 160) || existing.title,
    body: draft.body && draft.body.trim().length > 0 ? draft.body : existing.body,
    structure: { environment: env, inference: inf, constraints: con },
    domainTags,
    policyIds,
    sourceEpisodeIds,
    vec,
  };
}

// ─── Low-level helpers ─────────────────────────────────────────────────────

function mergeEntries<
  T extends { label: string; description: string; evidenceIds?: string[] },
>(prev: readonly T[], next: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const e of prev) byKey.set(entryKey(e), e);
  for (const e of next) byKey.set(entryKey(e), e);
  return Array.from(byKey.values()).slice(0, 24) as T[];
}

function entryKey(e: { label: string; description: string }): string {
  return `${e.label.toLowerCase().trim()}::${e.description.toLowerCase().trim().slice(0, 64)}`;
}

function mergeTags(prev: readonly string[], next: readonly string[]): string[] {
  const set = new Set<string>();
  for (const t of [...prev, ...next]) {
    const clean = t.trim().toLowerCase();
    if (clean.length > 0) set.add(clean);
  }
  return Array.from(set).slice(0, 6);
}

function mergeIds<T extends string>(prev: readonly T[], next: readonly T[]): T[] {
  const set = new Set<T>();
  for (const id of [...prev, ...next]) set.add(id);
  return Array.from(set);
}
