/**
 * Ranker — fuses candidates across tiers and enforces diversity.
 *
 * Design (2026 overhaul, aligned with `memos-local-openclaw::recall/engine`):
 *
 *   1. **Base = best channel score.** A candidate's base evidence is the
 *      strongest single-channel hit it has — cosine for vector, `1/(rank+1)`
 *      for FTS / pattern, `0.9` synthetic for structural error-signature.
 *      This puts all channels on a comparable (0, 1] footing without the
 *      "cosine=0 for keyword hits" trap the old formula had.
 *
 *   2. **RRF bonus across channels.** Multi-channel matches add
 *      `rrfWeight · Σ 1/(k + rank_i + 1)`. A row confirmed by 2+ channels
 *      gets a clear lift over single-channel false-positives.
 *
 *   3. **Tier-specific additive boosts.** V·decay (Tier-2) and η
 *      (Tier-1) are add-ons that differentiate rows *within* the same
 *      base-score band — not a dominant term that washes out the RRF
 *      signal.
 *
 *   4. **Multi-channel bypass.** Any candidate surfaced by ≥ 2 channels
 *      is exempt from the relative-threshold drop (it can still lose in
 *      MMR on redundancy). This is the backstop that guarantees a
 *      keyword-only hit confirmed by vector can never be silently
 *      dropped because a noisy topRelevance dragged the floor up.
 *
 *   5. **Smart-seed MMR.** Phase A seeds at most one candidate per tier,
 *      and only if its relevance is within `smartSeedRatio` of the pool
 *      top. Prevents "force-inject an irrelevant Tier-1 / Tier-3 just
 *      because the tier had a candidate".
 *
 * The module stays pure — no storage, no embedder, no side effects.
 */

import { cosinePrenormed, norm2 } from "../storage/vector.js";
import type { EmbeddingVector } from "../types.js";
import { priorityFor } from "../reward/backprop.js";
import type {
  ChannelRank,
  EpisodeCandidate,
  RetrievalChannel,
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
   * Base relevance used by MMR.
   *   relevance = bestChannelScore + rrfWeight · Σ 1/(k+rank+1)
   *             + priorityBoost (tier2)  + etaBoost (tier1)
   */
  relevance: number;
  /** Fused RRF score across channels (pre-weighting). */
  rrf: number;
  /** Final MMR-adjusted score. */
  score: number;
  /** `||vec||²`, cached for MMR. `null` means "no vec → treat as fully diverse". */
  normSq: number | null;
  /** True when this candidate was allowed past the threshold via the
   *  multi-channel bypass (useful for logs / "why did this survive?"). */
  bypassedThreshold?: boolean;
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
  /** Absolute floor applied (`topRelevance · floor`). */
  thresholdFloor: number;
  /** Channel hit counts aggregated across all candidates. */
  channelHits: Partial<Record<RetrievalChannel, number>>;
}

const DEFAULT_RELATIVE_THRESHOLD = 0.2;
const DEFAULT_SMART_SEED_RATIO = 0.7;
const DEFAULT_SKILL_ETA_BLEND = 0.15;
/**
 * How much each channel's RRF contribution is scaled by in the base
 * relevance formula. Kept small so that "best-channel-score" dominates
 * per-candidate but multi-channel agreement still gets a clear lift.
 */
const RRF_WEIGHT = 0.4;
/** Default priority blend — V·decay contributes this much at V=1. */
const DEFAULT_PRIORITY_BLEND = 0.3;

export function rank(input: RankerInput): RankerResult {
  const tierSizes: Record<TierKind, number> = {
    tier1: input.tier1.length,
    tier2: input.tier2Traces.length + input.tier2Episodes.length,
    tier3: input.tier3.length,
  };
  const kept: Record<TierKind, number> = { tier1: 0, tier2: 0, tier3: 0 };
  const channelHits: Partial<Record<RetrievalChannel, number>> = {};

  // ─── 1. Bag every candidate with relevance + RRF ──────────────────────────
  const bag: RankedCandidate[] = [];
  pushAll(bag, input.tier1, (c) => relevanceFor(c, input));
  pushAll(bag, input.tier2Traces, (c) => relevanceFor(c, input));
  pushAll(bag, input.tier2Episodes, (c) => relevanceFor(c, input));
  pushAll(bag, input.tier3, (c) => relevanceFor(c, input));

  // Tally channel hits for observability.
  for (const c of bag) {
    for (const ch of c.candidate.channels ?? []) {
      channelHits[ch.channel] = (channelHits[ch.channel] ?? 0) + 1;
    }
  }

  if (bag.length === 0) {
    return {
      ranked: [],
      tierSizes,
      kept,
      topRelevance: 0,
      droppedByThreshold: 0,
      thresholdFloor: 0,
      channelHits,
    };
  }

  assignChannelRrf(bag, input.config.rrfConstant);
  for (const c of bag) c.relevance += RRF_WEIGHT * c.rrf;

  // ─── 2. Relative threshold cut (with multi-channel bypass) ────────────────
  const topRelevance = bag.reduce((m, c) => Math.max(m, c.relevance), 0);
  const floorRatio =
    input.config.relativeThresholdFloor ?? DEFAULT_RELATIVE_THRESHOLD;
  const cutoff = topRelevance > 0 ? topRelevance * floorRatio : 0;
  const bypassEnabled = input.config.multiChannelBypass !== false;

  let droppedByThreshold = 0;
  const survivors: RankedCandidate[] = [];
  for (const c of bag) {
    const channels = c.candidate.channels ?? [];
    const multiChannel = bypassEnabled && channels.length >= 2;
    if (multiChannel) c.bypassedThreshold = true;
    if (cutoff > 0 && c.relevance < cutoff && !multiChannel) {
      droppedByThreshold += 1;
      continue;
    }
    survivors.push(c);
  }

  if (survivors.length === 0) {
    return {
      ranked: [],
      tierSizes,
      kept,
      topRelevance,
      droppedByThreshold,
      thresholdFloor: cutoff,
      channelHits,
    };
  }

  // ─── 3. MMR-style greedy pick ─────────────────────────────────────────────
  const λ = clamp(input.config.mmrLambda, 0, 1);
  const out: RankedCandidate[] = [];
  const selectedVecs: EmbeddingVector[] = [];
  const selectedNorms: number[] = [];
  const pool = [...survivors];
  const limit = Math.min(input.limit, survivors.length);
  const smartSeed = input.config.smartSeed !== false;
  const seedRatio = smartSeed
    ? input.config.smartSeedRatio ?? DEFAULT_SMART_SEED_RATIO
    : 0;
  const poolTop = pool.reduce((m, c) => Math.max(m, c.relevance), 0);
  const seedCutoff = smartSeed ? poolTop * seedRatio : 0;

  // Phase A — seeded picks per tier (preserves cross-tier diversity).
  // V7 §2.6: each tier answers a different question — we keep at most
  // one seed per tier so a packet is never a monoculture, but we only
  // seed if the tier's best candidate is within `smartSeedRatio` of the
  // pool top. Irrelevant Tier-1 / Tier-3 candidates no longer slip in
  // just because the tier was non-empty.
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
  return {
    ranked: out,
    tierSizes,
    kept,
    topRelevance,
    droppedByThreshold,
    thresholdFloor: cutoff,
    channelHits,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Per-candidate base relevance. New design:
 *
 *   relevance = bestChannelScore
 *             + priorityBlend · priorityForLive         (trace / episode)
 *             + skillEtaBlend · η                       (skill)
 *
 * RRF across channels is added *after* this function runs (so we have
 * access to `rrfConstant`). We start from `bestChannelScore` — which for
 * vec hits is cosine, for fts/pattern is `1/(rank+1)`, for structural is
 * the synthetic 0.9 — meaning an exact keyword hit at rank 0 starts at
 * the same base (1.0) as a cosine-1.0 hit. Without this, pure-keyword
 * hits with cosine=0 would score essentially zero and get guillotined
 * by the relative threshold.
 */
function relevanceFor(c: TierCandidate, input: RankerInput): number {
  const base = bestChannelScore(c);

  if (c.tier === "tier1") {
    const sk = c as SkillCandidate;
    const etaBlend = input.config.skillEtaBlend ?? DEFAULT_SKILL_ETA_BLEND;
    return base + etaBlend * clamp(sk.eta, 0, 1);
  }
  if (c.refKind === "trace") {
    const tc = c as TraceCandidate;
    const live = priorityFor(
      tc.value,
      tc.ts,
      input.config.decayHalfLifeDays,
      input.now,
    );
    const blend = priorityBlendFor(input.config);
    return base + blend * live;
  }
  if (c.refKind === "episode") {
    const ep = c as EpisodeCandidate;
    const live = priorityFor(
      ep.maxValue,
      ep.ts,
      input.config.decayHalfLifeDays,
      input.now,
    );
    const blend = priorityBlendFor(input.config);
    return base + blend * live;
  }
  // Tier 3 world-model — no V signal; rely on base + RRF.
  return base;
}

/**
 * `weightPriority` is kept in config for backwards-compat, but the new
 * default-semantics is: "how much priority lifts relevance at V=1".
 * Historically this was used as a linear weight on a `cos + priority`
 * blend where `cos` was already in 0~1; now `base` already carries a
 * 0~1 signal so we scale priority to a non-dominating floor (default
 * 0.3). Configs that explicitly set `weightPriority` higher than that
 * still work — their intent "priority matters more" is preserved.
 */
function priorityBlendFor(config: RetrievalConfig): number {
  const w = config.weightPriority;
  if (w == null || w <= 0) return 0;
  // Cap the effective blend so priority can't single-handedly push a
  // V=1 trace above a channel-confirmed keyword hit — priority is a
  // tie-breaker, not a dominant term.
  return Math.min(w, DEFAULT_PRIORITY_BLEND);
}

function bestChannelScore(c: TierCandidate): number {
  const channels = c.channels ?? [];
  if (channels.length === 0) {
    // Legacy path — callers that build candidates without `channels`
    // (unit tests, older fixtures) fall back to the raw cosine.
    return clamp(c.cosine, 0, 1);
  }
  let best = 0;
  for (const ch of channels) {
    if (ch.score > best) best = ch.score;
  }
  // If the candidate also carries a cosine (e.g. structural bumped),
  // honour it as a floor — structural hits set cosine=0.9 synthetically.
  return Math.max(best, clamp(c.cosine, 0, 1));
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
