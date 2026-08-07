import type { Logger } from "../types";
import type { SqliteStore } from "./sqlite";

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface VectorHit {
  chunkId: string;
  score: number;
}

/**
 * Uses sqlite-vec metadata for owner/session filters. A recent-chunk window
 * keeps the existing SQL implementation so the cap remains exact.
 */
export function vectorSearch(
  store: SqliteStore,
  queryVec: number[],
  topK: number,
  maxChunks?: number,
  ownerFilter?: string[],
  excludeSessionKey?: string,
  log?: Logger,
): VectorHit[] {
  const requiresRecentWindow = maxChunks != null && maxChunks > 0;

  const hasConfiguredIndex = typeof store.hasVecIndex === "function" && store.hasVecIndex();
  if (isVecIndexAvailable() && hasConfiguredIndex && !requiresRecentWindow) {
    try {
      return store.searchVecChunks(queryVec, topK, ownerFilter, excludeSessionKey).map((result) => ({
        chunkId: result.chunkId,
        score: 1 - result.distance,
      }));
    } catch (err) {
      log?.warn(`Indexed vector search failed; using brute force: ${err}`);
    }
  }

  const all = maxChunks != null && maxChunks > 0
    ? store.getRecentEmbeddings(maxChunks, ownerFilter, excludeSessionKey)
    : store.getAllEmbeddings(ownerFilter, excludeSessionKey);
  const scored = all.map((row) => ({
    chunkId: row.chunkId,
    score: cosineSimilarity(queryVec, row.vector),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function isVecIndexAvailable(): boolean {
  return process.env.MEMOS_USE_VEC_INDEX !== "false";
}

export function getSearchMode(): { useIndex: boolean; reason: string } {
  if (!isVecIndexAvailable()) {
    return { useIndex: false, reason: "MEMOS_USE_VEC_INDEX=false" };
  }
  return { useIndex: true, reason: "sqlite-vec indexed search" };
}
