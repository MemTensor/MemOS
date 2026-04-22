/**
 * Post-processing helpers for raw provider output:
 *   - pad / truncate to declared dimensionality
 *   - L2-normalize for cosine-friendly storage
 *   - convert to Float32Array
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { EmbeddingVector } from "../types.js";

export function toFloat32(v: number[]): EmbeddingVector {
  const f = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) f[i] = v[i]!;
  return f;
}

/**
 * Enforce the configured dimensionality.
 *
 * - If the provider returns *more* dimensions than configured, truncate (the
 *   old project did this so callers could safely switch to a smaller model).
 * - If fewer, throw. Silently zero-padding would poison downstream cosine.
 */
export function enforceDim(
  v: number[],
  expected: number,
  ctx: { provider: string; model: string; index?: number },
): number[] {
  if (v.length === expected) return v;
  if (v.length > expected) return v.slice(0, expected);
  throw new MemosError(
    ERROR_CODES.EMBEDDING_UNAVAILABLE,
    `Provider ${ctx.provider}/${ctx.model} returned ${v.length}-dim vector; expected ${expected}`,
    { provider: ctx.provider, model: ctx.model, got: v.length, expected, index: ctx.index },
  );
}

export function l2Normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  if (s === 0) return v;
  const inv = 1 / Math.sqrt(s);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
  return out;
}

/**
 * Process a raw provider result (arrays of numbers) into the `EmbeddingVector`
 * shape the storage layer expects. Respects `normalize` (default true).
 */
export function postProcess(
  raw: number[][],
  opts: {
    dimensions: number;
    provider: string;
    model: string;
    normalize: boolean;
  },
): EmbeddingVector[] {
  const out: EmbeddingVector[] = [];
  for (let i = 0; i < raw.length; i++) {
    const dimed = enforceDim(raw[i]!, opts.dimensions, {
      provider: opts.provider,
      model: opts.model,
      index: i,
    });
    const f32 = toFloat32(dimed);
    out.push(opts.normalize ? l2Normalize(f32) : f32);
  }
  return out;
}
