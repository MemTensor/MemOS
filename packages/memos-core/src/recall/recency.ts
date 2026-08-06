/**
 * Time decay scoring (PRD §5.3)
 *
 * Applies exponential decay based on document age, biasing towards
 * more recent memories. Uses configurable half-life (default 14 days).
 *
 * decay(t) = 0.5 ^ (age_days / half_life)
 * final = base_score * (alpha + (1-alpha) * decay)
 *
 * alpha=0.3 ensures old but highly relevant results are not zeroed out.
 */
export function applyRecencyDecay(
  candidates: Array<{ id: string; score: number; createdAt: number }>,
  halfLifeDays: number = 14,
  now?: number,
): Array<{ id: string; score: number }> {
  const currentTime = now ?? Date.now();
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  const alpha = 0.3;

  return candidates.map((c) => {
    const ageMs = Math.max(0, currentTime - c.createdAt);
    const decay = Math.pow(0.5, ageMs / halfLifeMs);
    const adjustedScore = c.score * (alpha + (1 - alpha) * decay);
    return { id: c.id, score: adjustedScore };
  });
}
