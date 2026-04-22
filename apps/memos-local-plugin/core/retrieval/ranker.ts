/**
 * Ranker — fuses candidates across tiers and enforces diversity.
 *
 * Three passes:
 *
 *   1. **Per-channel RRF.** Each `RankedCandidate` carries one
 *      `ChannelRank` per channel that contributed it (vec_summary,
 *      vec_action, fts, pattern, structural). The fused score is
 *      `Σ 1 / (k + rank_i + 1)` over those ranks. A row that surfaces
 *      in 3 channels gets a much bigger lift than a vector-only hit.
 *      This is what plugs the "single-channel false positive" hole.
 *
 *   2. **Relative threshold drop.** After computing per-candidate
 *      `relevance`, drop everyone whose `relevance < topRelevance ·
 *      relativeThresholdFloor`. Adaptive: a strong query (top score 0.9)
 *      keeps only items ≥ 0.36; a weak query (top 0.4) keeps items ≥ 0.16.
 *
 *   3. **MMR with smart per-tier seed.** Seed at most one candidate per
 *      non-empty tier (so a packet is never a single-tier monoculture)
 *      — but only seed a tier if its best candidate clears the relative
 *      threshold. This kills the "irrelevant skill / world-model gets
 *      force-injected" failure mode.
 *
 * This module is pure and framework-agnostic — no storage, no embedder,
 * no side effects. Unit testable by passing in plain arrays.
 */

import { cosinePrenormed, norm2 } from "../storage/vector.js";
import type { EmbeddingVector } from "../types.js";
import { priorityFor } from "../reward/backprop.js";
import type {
  ChannelRank,
  EpisodeCandidate,
  RetrievalConfig,
  SkillCandidate,
  TierCandidate,
  TierKind,
  TraceCandidate,
  WorldModelCandidate,
} from "./types.js";

export interface RankerInput {
  tier1: readonly SkillCandidate[];
  tier2Traces: readonly TraceCandidate[];
  tier2Episodes: readonly EpisodeCandidate[];
  tier3: readonly WorldModelCandidate[];
  /** Hard cap on total snippets after MMR. */
  limit: number;
  config: RetrievalConfig;
  now: number;
}

export interface RankedCandidate {
  candidate: TierCandidate;
  /**
   * Base relevance used by MMR. Blends:
   *   - cosine + priority (vector-aware tiers)
   *   - small η nudge for Tier-1
   *   - per-channel RRF lift (so multi-channel matches surface)
   */
  relevance: number;
  /** Fused RRF score across channels. */
  rrf: number;
  /** Final MMR-adjusted score. */
  score: number;
  /** `||vec||²`, cached for MMR. `null` means "no vec → treat as fully diverse". */
  normSq: number | null;
}

export interface RankerResult {
  ranked: RankedCandidate[];
  /** Count per tier *before* MMR. */
  tierSizes: Record<TierKind, number>;
  /** Count kept per tier after MMR. */
  kept: Record<TierKind, number>;
  /** Top relevance seen — useful for relative-threshold debugging. */
  topRelevance: number;
  /** Number of candidates the relative-threshold cut. */
  droppedByThreshold: number;
}

const DEFAULT_RELATIVE_THRESHOLD = 0.4;
const DEFAULT_SKILL_ETA_BLEND = 0.15;

export function rank(input: RankerInput): RankerResult {
  const tierSizes: Record<TierKind, number> = {
    tier1: input.tier1.length,
    tier2: input.tier2Traces.length + input.tier2Episodes.length,
    tier3: input.tier3.length,
  };
  const kept: Record<TierKind, number> = { tier1: 0, tier2: 0, tier3: 0 };

  // ─── 1. Bag every candidate with relevance + RRF ──────────────────────────
  const bag: RankedCandidate[] = [];
  pushAll(bag, input.tier1, (c) => relevanceFor(c, input));
  pushAll(bag, input.tier2Traces, (c) => relevanceFor(c, input));
  pushAll(bag, input.tier2Episodes, (c) => relevanceFor(c, input));
  pushAll(bag, input.tier3, (c) => relevanceFor(c, input));

  if (bag.length === 0) {
    return {
      ranked: [],
      tierSizes,
      kept,
      topRelevance: 0,
      droppedByThreshold: 0,
    };
  }

  assignChannelRrf(bag, input.config.rrfConstant);
  // Fold the channel-RRF into relevance so MMR + threshold both honour it.
  for (const c of bag) c.relevance += c.rrf;

  // ─── 2. Relative threshold cut ────────────────────────────────────────────
  const topRelevance = bag.reduce((m, c) => Math.max(m, c.relevance), 0);
  const floorRatio =
    input.config.relativeThresholdFloor ?? DEFAULT_RELATIVE_THRESHOLD;
  const cutoff = topRelevance > 0 ? topRelevance * floorRatio : 0;
  const droppedByThreshold = bag.filter((c) => c.relevance < cutoff).length;
  const survivors =
    cutoff > 0 ? bag.filter((c) => c.relevance >= cutoff) : [...bag];

  if (survivors.length === 0) {
    return { ranked: [], tierSizes, kept, topRelevance, droppedByThreshold };
  }

  // ─── 3. MMR-style greedy pick ─────────────────────────────────────────────
  const λ = clamp(input.config.mmrLambda, 0, 1);
  const out: RankedCandidate[] = [];
  const selectedVecs: EmbeddingVector[] = [];
  const selectedNorms: number[] = [];
  const pool = [...survivors];
  const limit = Math.min(input.limit, survivors.length);
  const smartSeed = input.config.smartSeed !== false;
  // Smart-seed cutoff: only seed a tier if its best candidate beats this.
  // Falls back to plain `cutoff` so we never seed an item we'd otherwise
  // drop. Setting `smartSeed = false` reverts to the legacy "seed best
  // of every non-empty tier".
  const seedCutoff = smartSeed ? cutoff : 0;

  // Phase A — seeded picks per tier (preserves cross-tier diversity).
  const seedTiers: TierKind[] = ["tier1", "tier2", "tier3"];
  for (const tk of seedTiers) {
    if (out.length >= limit) break;
    let bestIdx = -1;
    let bestRel = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      if (c.candidate.tier !== tk) continue;
      if (c.relevance > bestRel) {
        bestRel = c.relevance;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) continue;
    if (bestRel < seedCutoff) continue;
    const c = pool.splice(bestIdx, 1)[0]!;
    c.score = c.relevance;
    out.push(c);
    kept[tk] += 1;
    pushVec(selectedVecs, selectedNorms, c);
  }

  // Phase B — classic MMR loop on remaining pool.
  while (out.length < limit && pool.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const c = pool[i]!;
      const redundancy = maxCos(c, selectedVecs, selectedNorms);
      const mmr = λ * c.relevance - (1 - λ) * redundancy;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const [picked] = pool.splice(bestIdx, 1);
    picked!.score = bestScore;
    out.push(picked!);
    kept[picked!.candidate.tier] += 1;
    pushVec(selectedVecs, selectedNorms, picked!);
  }

  // Sort the final list by score desc (MMR scores are not guaranteed
  // monotone during the loop because Phase A seeds get their raw relevance).
  out.sort((a, b) => b.score - a.score || b.rrf - a.rrf);
  return { ranked: out, tierSizes, kept, topRelevance, droppedByThreshold };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function relevanceFor(c: TierCandidate, input: RankerInput): number {
  const cosW = input.config.weightCosine;
  const priW = input.config.weightPriority;
  const cos = clamp(c.cosine, -1, 1);

  if (c.tier === "tier1") {
    const sk = c as SkillCandidate;
    const etaBlend =
      input.config.skillEtaBlend ?? DEFAULT_SKILL_ETA_BLEND;
    // Cosine still dominates; η is a small reliability nudge.
    return cosW * cos + etaBlend * clamp(sk.eta, 0, 1);
  }
  if (c.refKind === "trace") {
    const tc = c as TraceCandidate;
    const live = priorityFor(tc.value, tc.ts, input.config.decayHalfLifeDays, input.now);
    return cosW * cos + priW * live;
  }
  if (c.refKind === "episode") {
    const ep = c as EpisodeCandidate;
    const live = priorityFor(ep.maxValue, ep.ts, input.config.decayHalfLifeDays, input.now);
    return cosW * cos + priW * live;
  }
  // Tier 3 — cosine only; world-models have no V.
  return cosW * cos;
}

function pushAll<C extends TierCandidate>(
  into: RankedCandidate[],
  src: readonly C[],
  relOf: (c: C) => number,
): void {
  for (const c of src) {
    const rel = relOf(c);
    const ns = c.vec ? norm2(c.vec) : null;
    into.push({ candidate: c, relevance: rel, rrf: 0, score: rel, normSq: ns });
  }
}

/**
 * Assign per-channel RRF lift for every candidate. Each `ChannelRank`
 * on a candidate contributes `1 / (k + rank + 1)`; sums sum across
 * channels. Multi-channel matches → bigger lift.
 */
function assignChannelRrf(into: readonly RankedCandidate[], k: number): void {
  for (const slot of into) {
    const channels = slot.candidate.channels ?? [];
    let s = 0;
    for (const ch of channels) {
      s += 1 / (k + ch.rank + 1);
    }
    slot.rrf = s;
  }
}

function maxCos(
  cand: RankedCandidate,
  selected: readonly EmbeddingVector[],
  selectedNorms: readonly number[],
): number {
  if (!cand.candidate.vec || selected.length === 0 || cand.normSq == null) {
    return 0;
  }
  const vec = cand.candidate.vec;
  const candNorm = Math.sqrt(cand.normSq);
  if (candNorm === 0) return 0;
  let m = 0;
  for (let i = 0; i < selected.length; i += 1) {
    const sn = Math.sqrt(selectedNorms[i]!);
    if (sn === 0) continue;
    const sim = cosinePrenormed(vec, candNorm, selected[i]!, selectedNorms[i]!);
    if (sim > m) m = sim;
  }
  return m;
}

function pushVec(
  vecs: EmbeddingVector[],
  norms: number[],
  c: RankedCandidate,
): void {
  if (!c.candidate.vec) return;
  vecs.push(c.candidate.vec);
  norms.push(c.normSq ?? norm2(c.candidate.vec));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Re-export for callers that want to inspect channels (debug / logs).
export type { ChannelRank };
