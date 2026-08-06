/**
 * Similarity helpers for the L2 association / induction steps.
 *
 * Trace↔policy similarity blends:
 *   - vector cosine between `trace.vecSummary` and `policy.vec` (if any),
 *   - signature overlap bonus (share tag / tool / errCode → +0.05 each),
 *   - hard gate when signatures disagree completely on primaryTag AND errCode.
 *
 * Scores are in [0, 1]. This is deliberately simple — V7 doesn't prescribe a
 * specific fusion; we just want a cheap, interpretable blend that works well
 * in practice.
 */

import type { EmbeddingVector, PolicyRow, TraceRow } from "../../types.js";
import { cosine } from "../../storage/vector.js";
import { componentsOf, parseSignature } from "./signature.js";
import type { SignatureComponents } from "./types.js";

export interface TracePolicySimilarity {
  score: number;
  cosine: number;
  sharedComponents: number; // 0..3
  policyId: string;
}

/**
 * Compute blended trace↔policy similarity.
 *
 * Policies are persisted with only one embedding (`policy.vec`); we use
 * `trace.vecSummary` when present, falling back to `vecAction`. When neither
 * side has an embedding we return 0 — the caller treats that as "no match".
 */
export function tracePolicySimilarity(
  trace: TraceRow,
  policy: PolicyRow,
  policySignature: SignatureComponents | null,
): TracePolicySimilarity {
  const traceVec = trace.vecSummary ?? trace.vecAction ?? null;
  const cos = (traceVec && policy.vec) ? Math.max(0, cosine(traceVec, policy.vec)) : 0;

  const traceSig = componentsOf(trace);
  const polSig =
    policySignature ?? parseSignature(`${policy.trigger.slice(0, 1)}|_|_|_`); // fallback
  const shared = countSharedComponents(traceSig, polSig ?? traceSig);

  // Hard gate: if primaryTag AND errCode are both different AND non-empty on
  // both sides, the policy is about a genuinely different sub-problem.
  const bothDifferent =
    isDistinct(traceSig.primaryTag, polSig?.primaryTag) &&
    isDistinct(traceSig.errCode, polSig?.errCode);

  const bonus = shared * 0.05;
  const score = bothDifferent ? Math.min(cos * 0.5 + bonus, 0.4) : Math.min(cos + bonus, 1);
  return { score, cosine: cos, sharedComponents: shared, policyId: policy.id };
}

/**
 * Trace↔trace similarity used inside the candidate pool. Purely vector-based
 * (we already bucket by signature before calling this).
 */
export function traceTraceSimilarity(a: TraceRow, b: TraceRow): number {
  const va = a.vecSummary ?? a.vecAction ?? null;
  const vb = b.vecSummary ?? b.vecAction ?? null;
  if (!va || !vb) return 0;
  return Math.max(0, cosine(va, vb));
}

/**
 * Value-weighted aggregation of a set of traces, used by gain.ts and for
 * logging "this policy explains +0.62 of V". V7 §0.6 eq. 3:
 *   w_t = softmax(V_t / τ)
 * Then weighted mean = Σ w_t · V_t.
 */
export function valueWeightedMean(
  traces: readonly TraceRow[],
  tau: number,
): number {
  if (traces.length === 0) return 0;
  const vs = traces.map((t) => t.value);
  const maxV = Math.max(...vs);
  const exps = vs.map((v) => Math.exp((v - maxV) / Math.max(tau, 1e-6)));
  const Z = exps.reduce((a, b) => a + b, 0) || 1;
  const weights = exps.map((e) => e / Z);
  let m = 0;
  for (let i = 0; i < vs.length; i++) m += weights[i] * vs[i];
  return m;
}

/**
 * Simple arithmetic mean — used for `G_without`. Weighted softmax doesn't
 * help the baseline leg because its variance is already what we care about.
 */
export function arithmeticMeanValue(traces: readonly TraceRow[]): number {
  if (traces.length === 0) return 0;
  let s = 0;
  for (const t of traces) s += t.value;
  return s / traces.length;
}

/**
 * Centroid of a set of embedding vectors (same dimension). Used as the
 * policy.vec for newly induced L2 rows.
 */
export function centroid(vectors: readonly (EmbeddingVector | null)[]): EmbeddingVector | null {
  const present = vectors.filter((v): v is EmbeddingVector => v !== null);
  if (present.length === 0) return null;
  const dim = present[0].length;
  const acc = new Float32Array(dim);
  for (const v of present) {
    if (v.length !== dim) continue; // skip mismatched
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }
  for (let i = 0; i < dim; i++) acc[i] /= present.length;
  return acc as unknown as EmbeddingVector;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function countSharedComponents(a: SignatureComponents, b: SignatureComponents): number {
  let c = 0;
  if (a.primaryTag !== "_" && a.primaryTag === b.primaryTag) c++;
  if (a.secondaryTag !== "_" && a.secondaryTag === b.secondaryTag) c++;
  if (a.tool !== "_" && a.tool === b.tool) c++;
  return c;
}

function isDistinct(x: string | undefined, y: string | undefined): boolean {
  if (!x || !y) return false;
  if (x === "_" || y === "_") return false;
  return x !== y;
}
