/**
 * `backprop` — normalized credit assignment with position smoothing.
 *
 * For traces in chronological order (t = 1..T):
 *
 *   f_t = (1-λ) + λ·γ^(T-t)
 *   recovery_t = 1 if α_t>0 and α_{t-1}=0 else 0
 *   r_t = 1 + δ·recovery_t
 *   w_t = α_t·f_t·r_t
 *   V_t = (w_t / Σw)·R_human            when Σw>0
 *   V_t = 0                              when Σw=0
 *
 * Priority stays:
 *   priority(f1_t) = max(V_t, 0) · decay(Δt)
 *   decay(Δt)     = 0.5 ^ (Δt_days / halfLifeDays)
 */

import { rootLogger } from "../logger/index.js";
import type { BackpropInput, BackpropResult, BackpropUpdate } from "./types.js";

const MS_PER_DAY = 86_400_000;

export function backprop(input: BackpropInput): BackpropResult {
  const log = rootLogger.child({ channel: "core.reward.backprop" });

  const gamma = clamp(input.gamma, 0, 1);
  const lambda = clamp(input.lambda, 0, 1);
  const delta = Math.max(0, Number.isFinite(input.delta) ? input.delta : 0);
  const rHuman = clamp(input.rHuman, -1, 1);
  const now = input.now ?? Date.now();
  const halfLife = Math.max(1, input.decayHalfLifeDays);

  const updates: BackpropUpdate[] = new Array(input.traces.length);
  if (input.traces.length === 0) {
    return {
      updates: [],
      meanAbsValue: 0,
      maxPriority: 0,
      echoParams: { gamma, lambda, delta, decayHalfLifeDays: halfLife, now },
    };
  }

  const effectiveAlpha: number[] = input.traces.map((trace) => alphaFromTrace(trace));
  const weights: number[] = new Array(input.traces.length).fill(0);
  let sumW = 0;
  let fallbackAlphaCount = 0;
  let unknownReflectionCount = 0;
  for (let i = 0; i < input.traces.length; i++) {
    const alpha = effectiveAlpha[i]!;
    const prevAlpha = i > 0 ? effectiveAlpha[i - 1]! : 0;
    const recovery = i > 0 && alpha > 0 && prevAlpha === 0 ? 1 : 0;
    const positional = (1 - lambda) + lambda * Math.pow(gamma, input.traces.length - 1 - i);
    const boost = 1 + delta * recovery;
    const w = alpha * positional * boost;
    weights[i] = w;
    sumW += w;
    const reflection = input.traces[i]!.reflection;
    if (!reflection || !reflection.trim()) fallbackAlphaCount += 1;
    else if (!KNOWN_REFLECTION_LABELS.has(reflection.trim())) unknownReflectionCount += 1;
  }

  let sumAbsV = 0;
  let maxPriority = 0;

  for (let i = 0; i < input.traces.length; i++) {
    const t = input.traces[i]!;
    const alpha = effectiveAlpha[i]!;
    const V = sumW > 0 ? (weights[i]! / sumW) * rHuman : 0;

    const dtDays = Math.max(0, (now - t.ts) / MS_PER_DAY);
    const decay = Math.pow(0.5, dtDays / halfLife);
    const priority = Math.max(V, 0) * decay;

    updates[i] = {
      traceId: t.id,
      value: V,
      alpha,
      priority,
    };
    sumAbsV += Math.abs(V);
    if (priority > maxPriority) maxPriority = priority;
  }

  const meanAbsValue = sumAbsV / updates.length;

  log.debug("backprop.computed", {
    traces: updates.length,
    rHuman,
    gamma,
    lambda,
    delta,
    sumW,
    fallbackAlphaCount,
    unknownReflectionCount,
    meanAbsValue,
    maxPriority,
  });

  return {
    updates,
    meanAbsValue,
    maxPriority,
    echoParams: { gamma, lambda, delta, decayHalfLifeDays: halfLife, now },
  };
}

/**
 * Standalone helper: priority for an existing (V, ts) pair. Exposed for
 * `core/memory/l1` retrieval tests and the L3 abstraction pass, both of
 * which need to reweight traces without re-running backprop.
 */
export function priorityFor(
  value: number,
  ts: number,
  decayHalfLifeDays: number,
  now = Date.now(),
): number {
  const halfLife = Math.max(1, decayHalfLifeDays);
  const dtDays = Math.max(0, (now - ts) / MS_PER_DAY);
  const decay = Math.pow(0.5, dtDays / halfLife);
  return Math.max(value, 0) * decay;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(lo, Math.min(hi, v));
}

const KNOWN_REFLECTION_LABELS = new Set([
  "IRRELEVANT",
  "RELATED",
  "PIVOTAL",
  "RELATED_DEFAULT",
]);

function alphaFromTrace(trace: BackpropInput["traces"][number]): number {
  const reflection = trace.reflection?.trim();
  if (reflection === "IRRELEVANT") return 0;
  if (reflection === "RELATED" || reflection === "RELATED_DEFAULT") return 0.5;
  if (reflection === "PIVOTAL") return 1;
  return clamp(trace.alpha, 0, 1);
}
