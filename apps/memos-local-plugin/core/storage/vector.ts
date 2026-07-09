/**
 * In-database vector storage + brute-force search.
 *
 * Design:
 *   - Vectors are stored as BLOB columns holding a little-endian Float32 buffer.
 *     Encoding: `encodeVector(Float32Array) -> Buffer`.
 *   - Each row additionally stores its squared L2 norm² (cached) so cosine
 *     similarity can be computed without recomputing sqrt on every query.
 *   - Search is brute-force: `SELECT id, vec, norm2 FROM <table> WHERE vec IS NOT NULL`
 *     then we compute cosine(q, v) in JS and keep top-K with a small heap.
 *   - We *intentionally* don't rely on sqlite-wasm or vss. Pure JS brute is
 *     ~1 M × 384 in <50ms on a laptop, which is plenty for local plugin use.
 *
 * When usage grows past, say, 100K rows per table, this module is the single
 * place to swap in an ANN index (e.g. hnswlib-node or faiss).
 */

import { rootLogger } from "../logger/index.js";
import type { EmbeddingVector } from "../types.js";
import type { StorageDb } from "./types.js";

const log = rootLogger.child({ channel: "storage.vector" });

// ─── Encoding ────────────────────────────────────────────────────────────────

const FLOAT32_BYTES = 4;

/** Float32Array → Buffer (little-endian, zero-copy when possible). */
export function encodeVector(vec: EmbeddingVector): Buffer {
  if (!(vec instanceof Float32Array)) {
    throw new Error("[storage.vector] encodeVector expects Float32Array");
  }
  // Node Buffers are always little-endian on our supported platforms.
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Buffer → Float32Array. Copies so callers can't mutate the underlying DB blob. */
export function decodeVector(buf: Buffer | Uint8Array | null | undefined): EmbeddingVector | null {
  if (!buf) return null;
  if (buf.byteLength === 0) return new Float32Array(0);
  if (buf.byteLength % FLOAT32_BYTES !== 0) {
    throw new Error(
      `[storage.vector] decoded buffer is not aligned to float32 (${buf.byteLength} bytes)`,
    );
  }
  const view = new Uint8Array(buf);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return new Float32Array(copy.buffer, 0, view.byteLength / FLOAT32_BYTES);
}

// ─── Math ────────────────────────────────────────────────────────────────────

export function dot(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) {
    throw new Error(`[storage.vector] dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function norm2(a: EmbeddingVector): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return s;
}

export function cosine(a: EmbeddingVector, b: EmbeddingVector): number {
  const d = dot(a, b);
  const na = Math.sqrt(norm2(a));
  const nb = Math.sqrt(norm2(b));
  if (na === 0 || nb === 0) return 0;
  return d / (na * nb);
}

/**
 * Cosine similarity using pre-computed norm² of `b`. Saves one sqrt + one pass
 * per candidate when the query side is fixed.
 */
export function cosinePrenormed(
  a: EmbeddingVector,
  aNorm: number,
  b: EmbeddingVector,
  bNorm2: number,
): number {
  if (aNorm === 0 || bNorm2 === 0) return 0;
  return dot(a, b) / (aNorm * Math.sqrt(bNorm2));
}

// ─── Top-K brute search ──────────────────────────────────────────────────────

export interface VectorRow<TId = string, TMeta = undefined> {
  id: TId;
  vec: EmbeddingVector;
  /** Pre-computed L2 norm². If absent we compute + cache. */
  norm2?: number;
  meta?: TMeta;
}

export interface VectorHit<TId = string, TMeta = undefined> {
  id: TId;
  score: number;           // cosine in [-1, 1]
  meta?: TMeta;
}

/**
 * Brute-force top-K cosine search over an in-memory array of rows. Stable
 * (ties ordered by input order). Mutates `rows[i].norm2` if it was missing.
 */
export function topKCosine<TId = string, TMeta = undefined>(
  query: EmbeddingVector,
  rows: Array<VectorRow<TId, TMeta>>,
  k: number,
): Array<VectorHit<TId, TMeta>> {
  if (k <= 0 || rows.length === 0) return [];
  const qNorm = Math.sqrt(norm2(query));
  if (qNorm === 0) return [];

  // Simple n*log(k) approach: maintain a bounded min-heap on score.
  const heap: Array<VectorHit<TId, TMeta>> = [];
  for (const row of rows) {
    if (row.vec.length === 0) continue;
    if (row.vec.length !== query.length) {
      log.warn("search.dim_mismatch", {
        expected: query.length,
        got: row.vec.length,
        rowId: String(row.id),
      });
      continue;
    }
    if (row.norm2 === undefined) row.norm2 = norm2(row.vec);
    const score = cosinePrenormed(query, qNorm, row.vec, row.norm2);
    pushBounded(heap, { id: row.id, score, meta: row.meta }, k);
  }
  // `heap` is a min-heap on score; caller wants DESC.
  heap.sort((a, b) => b.score - a.score);
  return heap;
}

function pushBounded<T extends { score: number }>(heap: T[], item: T, k: number): void {
  if (heap.length < k) {
    heap.push(item);
    siftUp(heap, heap.length - 1);
    return;
  }
  if (item.score <= heap[0]!.score) return; // can't make top-K
  heap[0] = item;
  siftDown(heap, 0);
}

function siftUp<T extends { score: number }>(heap: T[], i: number): void {
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p]!.score <= heap[i]!.score) break;
    [heap[p], heap[i]] = [heap[i]!, heap[p]!];
    i = p;
  }
}

function siftDown<T extends { score: number }>(heap: T[], i: number): void {
  const n = heap.length;
  for (;;) {
    const l = 2 * i + 1;
    const r = 2 * i + 2;
    let smallest = i;
    if (l < n && heap[l]!.score < heap[smallest]!.score) smallest = l;
    if (r < n && heap[r]!.score < heap[smallest]!.score) smallest = r;
    if (smallest === i) break;
    [heap[i], heap[smallest]] = [heap[smallest]!, heap[i]!];
    i = smallest;
  }
}

// ─── Convenience: scan a column and run top-K ────────────────────────────────

export interface VectorScanOptions {
  /** Name of the BLOB column holding the vector. */
  vecColumn: string;
  /** Name of the REAL column caching norm². If absent we compute per-row. */
  norm2Column?: string;
  /** Optional WHERE clause (without the "WHERE"). */
  where?: string;
  /** Parameters for the WHERE clause. */
  params?: Record<string, unknown>;
  /** Optional LIMIT to cap candidates fetched from SQLite. */
  hardCap?: number;
}

export interface ScanRow {
  id: string;
  vec: Buffer | null;
  norm2?: number | null;
  [k: string]: unknown;
}

/**
 * Stream rows from `table`, decode vectors, and run top-K cosine against
 * `query`. `selectExtra` lets callers bring along columns that will surface in
 * `VectorHit.meta`.
 */
export function scanAndTopK<TMeta = undefined>(
  db: StorageDb,
  table: string,
  selectExtra: string[],
  query: EmbeddingVector,
  k: number,
  opts: VectorScanOptions,
): Array<VectorHit<string, TMeta>> {
  const { vecColumn, norm2Column, where, params, hardCap } = opts;
  const cols = ["id", vecColumn, ...(norm2Column ? [norm2Column] : []), ...selectExtra];
  const sql = [
    `SELECT ${cols.join(", ")} FROM ${table}`,
    where ? `WHERE ${where}` : "",
    `LIMIT ${hardCap ?? 100000}`,
  ]
    .filter(Boolean)
    .join(" ");

  const rows = db.prepare<typeof params, ScanRow>(sql).all(params);
  const decoded: Array<VectorRow<string, TMeta>> = [];
  for (const r of rows) {
    const vec = decodeVector(r[vecColumn] as Buffer | null);
    if (!vec) continue;
    const meta = selectExtra.length > 0
      ? (Object.fromEntries(selectExtra.map((c) => [c, r[c]])) as TMeta)
      : (undefined as TMeta);
    decoded.push({
      id: String(r["id"]),
      vec,
      norm2: norm2Column ? ((r[norm2Column] as number | null) ?? undefined) : undefined,
      meta,
    });
  }
  return topKCosine(query, decoded, k);
}
