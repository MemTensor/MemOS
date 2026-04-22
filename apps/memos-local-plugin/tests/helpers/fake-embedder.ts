/**
 * Deterministic embedder for tests. Turns each string into a unit vector
 * derived from a hash of its content. Ordering & dedup behaviour of the
 * real `Embedder` interface is preserved.
 */

import { createHash } from "node:crypto";

import type {
  EmbedInput,
  EmbedStats,
  Embedder,
  EmbeddingProviderName,
} from "../../core/embedding/types.js";
import type { EmbeddingVector } from "../../core/types.js";

export interface FakeEmbedderOptions {
  dimensions?: number;
  provider?: EmbeddingProviderName;
  model?: string;
  /**
   * If set, every call to `embedOne`/`embedMany` throws this error. Useful
   * for exercising failure handling in `capture/embedder.ts`.
   */
  throwWith?: Error;
}

export function fakeEmbedder(opts: FakeEmbedderOptions = {}): Embedder {
  const dims = opts.dimensions ?? 8;
  const provider = opts.provider ?? "local";
  const model = opts.model ?? "fake-embedder";
  const stats: EmbedStats = {
    hits: 0,
    misses: 0,
    requests: 0,
    roundTrips: 0,
    failures: 0,
    lastOkAt: null,
    lastError: null,
  };

  function vectorFor(text: string): EmbeddingVector {
    if (opts.throwWith) throw opts.throwWith;
    const hash = createHash("sha256").update(text).digest();
    const arr = new Float32Array(dims);
    for (let i = 0; i < dims; i++) {
      arr[i] = ((hash[i % hash.length]! / 255) - 0.5) * 2;
    }
    // L2-normalize.
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += arr[i]! * arr[i]!;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dims; i++) arr[i]! /= norm;
    return arr;
  }

  return {
    dimensions: dims,
    provider,
    model,
    async embedOne(input: string | EmbedInput): Promise<EmbeddingVector> {
      stats.requests++;
      stats.misses++;
      stats.roundTrips++;
      const text = typeof input === "string" ? input : input.text;
      return vectorFor(text);
    },
    async embedMany(inputs: Array<string | EmbedInput>): Promise<EmbeddingVector[]> {
      stats.requests += inputs.length;
      stats.misses += inputs.length;
      stats.roundTrips++;
      return inputs.map((inp) => vectorFor(typeof inp === "string" ? inp : inp.text));
    },
    stats() {
      return { ...stats };
    },
    resetCache() {
      stats.hits = 0;
      stats.misses = 0;
    },
    async close(): Promise<void> {
      /* noop */
    },
  };
}
