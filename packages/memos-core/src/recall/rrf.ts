/**
 * Reciprocal Rank Fusion (PRD §5.2)
 *
 * Merges ranked lists from different retrieval sources (FTS, vector)
 * into a single ranking. Handles score scale mismatch between BM25
 * and cosine similarity.
 *
 * RRF(d) = Σ 1 / (k + rank_i(d))
 * where k is a constant (default 60) and rank_i is the rank in list i.
 */
export interface RankedItem {
  id: string;
  score: number;
}

export function rrfFuse(
  lists: RankedItem[][],
  k: number = 60,
): Map<string, number> {
  const scores = new Map<string, number>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const prev = scores.get(item.id) ?? 0;
      scores.set(item.id, prev + 1 / (k + rank + 1));
    }
  }

  return scores;
}
