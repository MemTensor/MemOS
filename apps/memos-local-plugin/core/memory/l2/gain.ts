/**
 * Policy gain bookkeeping (V7 §0.6 eq. 4 / §2.4.5 row ③):
 *
 *   G(f²) = mean(V_with) − mean(V_without)
 *
 * Because we rarely have both sets ready at induction time, `computeGain`
 * accepts whatever you have and leaves the rest to a later pass.
 *
 * We use **value-weighted** mean for the with-set (softmax(V/τ)), as V7
 * specifies — this prevents a single outlier failure from tanking the
 * positive set. The without-set uses arithmetic mean (its variance is
 * itself signal).
 */

import type { PolicyId, TraceRow } from "../../types.js";
import { arithmeticMeanValue, valueWeightedMean } from "./similarity.js";
import type { GainInput, GainResult } from "./types.js";

export interface ComputeGainOpts {
  tauSoftmax: number;
}

export function computeGain(input: GainInput, opts: ComputeGainOpts): GainResult {
  const weightedWith = valueWeightedMean(input.withTraces, opts.tauSoftmax);
  const withMean = arithmeticMeanValue(input.withTraces);
  const withoutMean = arithmeticMeanValue(input.withoutTraces);
  const effectiveWith = input.withTraces.length >= 3 ? weightedWith : withMean;
  const gain = effectiveWith - withoutMean;
  return {
    policyId: input.policyId,
    gain,
    withMean,
    withoutMean,
    withCount: input.withTraces.length,
    withoutCount: input.withoutTraces.length,
    weightedWith,
  };
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
