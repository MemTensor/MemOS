/**
 * Post-rank dedupe: avoid injecting both trace(s) and an episode rollup for
 * the same `episodeId`.
 *
 * `rollupEpisodes` builds episode summaries from the same trace pool that
 * also enters ranking as individual traces, so MMR can keep both. After
 * LLM filter, choose either the trace side or the episode side for each
 * episode. Multiple trace hits from the same episode are still distinct
 * concrete turns and are preserved unless an episode rollup wins the group.
 */

import type { RankedCandidate } from "./ranker.js";
import type { EpisodeCandidate, TierCandidate, TraceCandidate } from "./types.js";
import type { EpisodeId } from "../types.js";

export interface DedupeTraceEpisodeResult {
  ranked: RankedCandidate[];
  dedupedByEpisodeCount: number;
}

function episodeIdOf(candidate: TierCandidate): EpisodeId | null {
  if (candidate.refKind === "trace") {
    return (candidate as TraceCandidate).episodeId;
  }
  if (candidate.refKind === "episode") {
    return (candidate as EpisodeCandidate).refId;
  }
  return null;
}

function compareTraceEpisodeRanked(a: RankedCandidate, b: RankedCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const aEp = a.candidate.refKind === "episode";
  const bEp = b.candidate.refKind === "episode";
  if (aEp && !bEp) return -1;
  if (!aEp && bEp) return 1;
  return b.relevance - a.relevance;
}

export function dedupeTraceEpisodeByEpisodeId(
  ranked: readonly RankedCandidate[],
): DedupeTraceEpisodeResult {
  const groups = new Map<
    string,
    { traces: RankedCandidate[]; episodes: RankedCandidate[] }
  >();
  for (const r of ranked) {
    const epId = episodeIdOf(r.candidate);
    if (!epId) continue;
    const group = groups.get(epId) ?? { traces: [], episodes: [] };
    if (r.candidate.refKind === "trace") group.traces.push(r);
    if (r.candidate.refKind === "episode") group.episodes.push(r);
    groups.set(epId, group);
  }
  if (groups.size === 0) {
    return { ranked: [...ranked], dedupedByEpisodeCount: 0 };
  }

  const dropped = new Set<RankedCandidate>();
  for (const group of groups.values()) {
    if (group.traces.length === 0 || group.episodes.length === 0) continue;

    const bestTrace = [...group.traces].sort(compareTraceEpisodeRanked)[0]!;
    const bestEpisode = [...group.episodes].sort(compareTraceEpisodeRanked)[0]!;
    const winner = compareTraceEpisodeRanked(bestTrace, bestEpisode) <= 0
      ? bestTrace
      : bestEpisode;

    if (winner.candidate.refKind === "episode") {
      group.traces.forEach((r) => dropped.add(r));
      group.episodes.filter((r) => r !== winner).forEach((r) => dropped.add(r));
    } else {
      group.episodes.forEach((r) => dropped.add(r));
    }
  }

  const rankedOut = ranked.filter((r) => !dropped.has(r));

  return { ranked: rankedOut, dedupedByEpisodeCount: dropped.size };
}
