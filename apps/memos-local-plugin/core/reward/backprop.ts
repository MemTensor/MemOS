/**
 * `backprop` — V7 §0.6 eq. 4+5 + §3.3 priority formula.
 *
 * Given traces in chronological order and a terminal reward `rHuman`,
 * compute `V_t` for each step by walking RIGHT-TO-LEFT:
 *
 *   V_T = R_human
 *   V_t = α_t · R_human + (1 − α_t) · γ · V_{t+1}
 *
 * Then compute priority with exponential time decay:
 *
 *   priority(f1_t) = max(V_t, 0) · decay(Δt)
 *   decay(Δt)     = 0.5 ^ (Δt_days / halfLifeDays)
 *
 * Pure function — no I/O. The caller persists via `tracesRepo.updateScore`.
 *
 * Design notes:
 *  - `alpha` is already clamped to [0, 1] by capture, but we clamp again
 *    defensively in case a downstream rescoring widened it.
 *  - `rHuman` is clamped to [-1, 1] to guarantee `V_t` stays in range.
 *  - A trace with no reflection (α=0) gets V_t via pure γ-discount, which
 *    matches V7 §0.6: "pure trial-and-error steps propagate by γ only".
 *  - Priority uses `max(V, 0)` because V7 §3.3 says negative value traces
 *    sink to the bottom but MUST remain on disk — they can still be
 *    surfaced by Decision Repair.
 *  - We do NOT touch `r_human` or `alpha` on the trace row: α stays
 *    capture-owned; r_human is episode-level and lives in `episodes.r_task`.
 */

import { rootLogger } from "../logger/index.js";
import type { BackpropInput, BackpropResult, BackpropUpdate } from "./types.js";

const MS_PER_DAY = 86_400_000;

export function backprop(input: BackpropInput): BackpropResult {
  const log = rootLogger.child({ channel: "core.reward.backprop" });

  const gamma = clamp(input.gamma, 0, 1);
  const rHuman = clamp(input.rHuman, -1, 1);
  const now = input.now ?? Date.now();
  const halfLife = Math.max(1, input.decayHalfLifeDays);

  const updates: BackpropUpdate[] = new Array(input.traces.length);
  if (input.traces.length === 0) {
    return {
      updates: [],
      meanAbsValue: 0,
      maxPriority: 0,
      echoParams: { gamma, decayHalfLifeDays: halfLife, now },
    };
  }

  // Walk last → first so V_{t+1} is always available.
  let nextV = rHuman;
  let sumAbsV = 0;
  let maxPriority = 0;

  for (let i = input.traces.length - 1; i >= 0; i--) {
    const t = input.traces[i]!;
    const alpha = clamp(t.alpha, 0, 1);
    const V = i === input.traces.length - 1
      ? rHuman // V_T = R_human (V7 §0.6 boundary case)
      : alpha * rHuman + (1 - alpha) * gamma * nextV;

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
    nextV = V;
  }

  const meanAbsValue = sumAbsV / updates.length;

  log.debug("backprop.computed", {
    traces: updates.length,
    rHuman,
    gamma,
    meanAbsValue,
    maxPriority,
  });

  return {
    updates,
    meanAbsValue,
    maxPriority,
    echoParams: { gamma, decayHalfLifeDays: halfLife, now },
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
