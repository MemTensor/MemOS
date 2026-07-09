import type { SqliteStore } from "./sqlite";

export function cosineSimilarity(a: number[], b: number[]): number {
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
 * Brute-force vector search over stored embeddings.
 * When maxChunks > 0, only searches the most recent maxChunks chunks (uses index; avoids full scan as data grows).
 * When excludeSessionKey is set, chunks whose session_key equals it are filtered out before scoring,
 * so the caller can suppress recall of the current conversation session.
 */
export function vectorSearch(
  store: SqliteStore,
  queryVec: number[],
  topK: number,
  maxChunks?: number,
  ownerFilter?: string[],
  excludeSessionKey?: string,
): VectorHit[] {
  const all = maxChunks != null && maxChunks > 0
    ? store.getRecentEmbeddings(maxChunks, ownerFilter, excludeSessionKey)
    : store.getAllEmbeddings(ownerFilter, excludeSessionKey);
  const scored: VectorHit[] = all.map((row) => ({
    chunkId: row.chunkId,
    score: cosineSimilarity(queryVec, row.vector),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
