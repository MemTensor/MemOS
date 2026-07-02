/**
 * Policy gain bookkeeping (V7 §0.6 eq. 4 / §2.4.5 row ③) with a
 * **shrinkage-anchored** baseline.
 *
 *   G(f²) = mean(V_with) − blendedWithoutMean
 *
 *   blendedWithoutMean
 *     = (mean(V_without)·n_without + V7_NEUTRAL·N₀) / (n_without + N₀)
 *
 * Where:
 *   - V7_NEUTRAL = 0.5 — the V7 §0.6 scoring rubric anchors a neutral /
 *     "no signal" reward at this value (R_human is in [-1, 1]; backprop'd
 *     V values for typical successful turns sit at 0.5–0.85, neutral
 *     baseline at 0.5, failures at < 0.5 down to negative).
 *   - N₀ = 5 — pseudocount weight of the prior, expressed in "virtual
 *     without-samples". With N₀ = 5 a policy needs ≥ 5 real comparable
 *     traces before the empirical without-mean fully overrides the prior.
 *
 * **Why shrinkage?** The original V7 formula `G = mean(V_with) −
 * mean(V_without)` assumes the training corpus contains failure cohorts
 * that drag `mean(V_without)` below `mean(V_with)`. In real interactive
 * usage:
 *
 *   1. Almost every episode is graded as a success (R_human ≈ 0.6–0.85).
 *   2. The reward backprop spreads similar V values across all step
 *      traces, so without-set traces (other episodes) end up at the same
 *      0.5–0.7 band as with-set traces.
 *   3. The empirical difference collapses to ≈ 0 by construction, no
 *      matter how genuinely useful the policy is.
 *
 * Anchoring the without-set against a neutral 0.5 prior fixes this:
 *
 *   - A policy whose with-set lives at V ≈ 0.8 now scores G ≈ 0.3 even
 *     when no failure-cohort exists (the neutral baseline guarantees a
 *     positive lift for genuinely-useful policies).
 *   - A policy whose with-set is mediocre (V ≈ 0.5) still scores G ≈ 0
 *     and stays in `candidate`.
 *   - A truly harmful policy (with-set V < 0.5) goes negative and is
 *     archived by `archiveGain` (-0.05 default).
 *   - As real comparable evidence accumulates, the prior gracefully
 *     dilutes and we recover the V7 §0.6 contrast formulation.
 *
 * We use **value-weighted** mean for the with-set (softmax(V/τ)), as V7
 * specifies — this prevents a single outlier failure from tanking the
 * positive set. The without-set keeps an arithmetic mean (its variance
 * is itself signal).
 */

import type { PolicyId, TraceRow } from "../../types.js";
import { arithmeticMeanValue, valueWeightedMean } from "./similarity.js";
import type { GainInput, GainResult } from "./types.js";

/** V7 §0.6 neutral-reward anchor (midpoint of the [-1, 1] R_human band). */
export const V7_NEUTRAL_BASELINE = 0.5;

/**
 * Pseudocount of "virtual without-samples" used to shrink the empirical
 * mean toward {@link V7_NEUTRAL_BASELINE}. Higher = the prior dominates
 * for longer; lower = empirical without-mean takes over after fewer real
 * samples. Five is roughly "one short episode worth" of signal.
 */
export const WITHOUT_PRIOR_PSEUDOCOUNT = 5;
export const MIN_ADAPTIVE_BASELINE = 0.2;

export interface ComputeGainOpts {
  tauSoftmax: number;
}

export function computeGain(input: GainInput, opts: ComputeGainOpts): GainResult {
  const weightedWith = valueWeightedMean(input.withTraces, opts.tauSoftmax);
  const withMean = arithmeticMeanValue(input.withTraces);
  const withoutMean = arithmeticMeanValue(input.withoutTraces);
  const effectiveWith = input.withTraces.length >= 3 ? weightedWith : withMean;
  const allTraces = [...input.withTraces, ...input.withoutTraces];
  const poolMean = allTraces.length > 0
    ? arithmeticMeanValue(allTraces)
    : V7_NEUTRAL_BASELINE;
  const baseline = adaptiveBaseline(poolMean);
  const blendedWithout = shrinkTowardBaseline(
    withoutMean,
    input.withoutTraces.length,
    baseline,
    WITHOUT_PRIOR_PSEUDOCOUNT,
  );
  const gain = effectiveWith - blendedWithout;
  return {
    policyId: input.policyId,
    gain,
    withMean,
    withoutMean,
    withCount: input.withTraces.length,
    withoutCount: input.withoutTraces.length,
    weightedWith,
    poolMean,
    baseline,
  };
}

export function adaptiveBaseline(poolMean: number): number {
  if (!Number.isFinite(poolMean)) return V7_NEUTRAL_BASELINE;
  return Math.max(MIN_ADAPTIVE_BASELINE, Math.min(V7_NEUTRAL_BASELINE, poolMean));
}

export function smoothGain(args: {
  newGain: number;
  currentGain: number;
  alpha: number;
  isFirst: boolean;
}): number {
  if (args.isFirst) return args.newGain;
  const alpha = clamp01(args.alpha);
  return alpha * args.newGain + (1 - alpha) * args.currentGain;
}

/**
 * Beta-binomial style shrinkage: the empirical mean over `nObserved`
 * samples is blended with a `priorMean` carrying `priorPseudocount` of
 * virtual evidence. As `nObserved` → ∞ the empirical mean wins; as it
 * → 0 the prior fully governs.
 */
function shrinkTowardBaseline(
  empiricalMean: number,
  nObserved: number,
  priorMean: number,
  priorPseudocount: number,
): number {
  const denom = nObserved + priorPseudocount;
  if (denom <= 0) return priorMean;
  return (empiricalMean * nObserved + priorMean * priorPseudocount) / denom;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Decide what status a policy should hold given support + gain + current
 * status. Used after gain recomputation; returns the possibly-new status.
 *
 * Rules:
 *   - `candidate` → `active`   when support ≥ minSupport AND gain ≥ minGain.
 *   - `active`    → `archived` when gain < archiveGain OR support drops to 0.
 *   - Otherwise keep the current status.
 */
export function nextStatus(args: {
  currentStatus: "candidate" | "active" | "archived";
  support: number;
  gain: number;
  thresholds: {
    minSupport: number;
    minGain: number;
    archiveGain: number;
  };
}): "candidate" | "active" | "archived" {
  const { currentStatus: status, support, gain, thresholds } = args;
  if (status === "archived") return "archived";
  if (status === "candidate") {
    if (support >= thresholds.minSupport && gain >= thresholds.minGain) return "active";
    return "candidate";
  }
  // active
  if (gain < thresholds.archiveGain || support <= 0) return "archived";
  return "active";
}

export type ApplyGainPersist = (args: {
  policyId: PolicyId;
  support: number;
  gain: number;
  status: "candidate" | "active" | "archived";
  updatedAt: number;
}) => void;

export function applyGain(args: {
  gain: GainResult;
  deltaSupport: number;
  currentStatus: "candidate" | "active" | "archived";
  thresholds: { minSupport: number; minGain: number; archiveGain: number };
  persist: ApplyGainPersist;
  currentSupport: number;
  now?: number;
}): { status: "candidate" | "active" | "archived"; support: number; gain: number } {
  const support = Math.max(0, args.currentSupport + args.deltaSupport);
  const status = nextStatus({
    currentStatus: args.currentStatus,
    support,
    gain: args.gain.gain,
    thresholds: args.thresholds,
  });
  args.persist({
    policyId: args.gain.policyId,
    support,
    gain: args.gain.gain,
    status,
    updatedAt: args.now ?? Date.now(),
  });
  return { status, support, gain: args.gain.gain };
}

/**
 * Convenience — split a trace list into those that should feed a policy's
 * with-set vs without-set, purely by "did this trace explicitly reference
 * the policy?". In V7 terms, we rely on `evidence` markers (out-of-scope
 * here; callers decide).
 */
export function partition(
  traces: readonly TraceRow[],
  predicate: (t: TraceRow) => boolean,
): { yes: TraceRow[]; no: TraceRow[] } {
  const yes: TraceRow[] = [];
  const no: TraceRow[] = [];
  for (const t of traces) (predicate(t) ? yes : no).push(t);
  return { yes, no };
}
