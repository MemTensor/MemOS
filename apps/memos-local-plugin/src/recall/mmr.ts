import { cosineSimilarity } from "../storage/vector";
import type { SqliteStore } from "../storage/sqlite";

/**
 * Maximal Marginal Relevance (PRD §5.3)
 *
 * Re-ranks candidates to balance relevance with diversity,
 * preventing top-K results from being too similar.
 *
 * MMR = λ · sim(q, d) - (1-λ) · max(sim(d, d_selected))
 */
export function mmrRerank(
  candidates: Array<{ id: string; score: number }>,
  store: SqliteStore,
  lambda: number = 0.7,
  topK: number = 20,
): Array<{ id: string; score: number }> {
  if (candidates.length <= 1) return candidates;

  const embeddings = new Map<string, number[]>();
  for (const c of candidates) {
    const vec = store.getEmbedding(c.id);
    if (vec) embeddings.set(c.id, vec);
  }

  const selected: Array<{ id: string; score: number }> = [];
  const remaining = [...candidates];

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const candVec = embeddings.get(cand.id);

      let maxSimToSelected = 0;
      if (candVec && selected.length > 0) {
        for (const s of selected) {
          const sVec = embeddings.get(s.id);
          if (sVec) {
            const sim = cosineSimilarity(candVec, sVec);
            maxSimToSelected = Math.max(maxSimToSelected, sim);
          }
        }
      }

      const mmrScore = lambda * cand.score - (1 - lambda) * maxSimToSelected;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = i;
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0];
    // Preserve original RRF score for downstream filtering;
    // MMR only determines selection order, not the score value.
    selected.push({ id: chosen.id, score: chosen.score });
  }

  return selected;
}
