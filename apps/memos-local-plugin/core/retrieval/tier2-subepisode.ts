import type { TraceId } from "../../agent-contract/dto.js";
import type { EmbeddingVector } from "../types.js";
import type {
  ChannelRank,
  RetrievalConfig,
  RetrievalRepos,
  SubEpisodeCandidate,
} from "./types.js";

const DEFAULT_KEYWORD_TOPK = 20;

export interface Tier2SubEpisodeDeps {
  repos: Pick<RetrievalRepos, "subEpisodes">;
  config: RetrievalConfig;
}

export interface Tier2SubEpisodeInput {
  queryVec: EmbeddingVector | null;
  tags: readonly string[];
  patternTerms?: readonly string[];
  includeLowValue?: boolean;
}

export function runTier2SubEpisode(
  deps: Tier2SubEpisodeDeps,
  input: Tier2SubEpisodeInput,
): SubEpisodeCandidate[] {
  const repo = deps.repos.subEpisodes;
  if (!repo) return [];
  const includeLow = input.includeLowValue ?? deps.config.includeLowValue;
  const valueWhere = includeLow ? undefined : "priority > 0";
  const vecPoolSize = Math.max(
    deps.config.tier2TopK,
    Math.ceil(deps.config.tier2TopK * deps.config.candidatePoolFactor),
  );
  const keywordPoolSize = Math.max(
    deps.config.tier2TopK,
    deps.config.keywordTopK ?? DEFAULT_KEYWORD_TOPK,
  );
  const tagsForStorage = resolveTagFilter(input.tags, deps.config);
  const blended = new Map<string, { cosine: number; channels: ChannelRank[]; vec: EmbeddingVector | null }>();

  if (input.queryVec && input.queryVec.length > 0) {
    const hits = repo.searchByVector(input.queryVec, vecPoolSize, {
      where: valueWhere,
      anyOfTags: tagsForStorage,
      hardCap: vecPoolSize * 4,
    });
    hits.forEach((hit, idx) => {
      blended.set(hit.id, {
        cosine: hit.score,
        vec: input.queryVec,
        channels: [{ channel: "vec_summary", rank: idx, score: hit.score }],
      });
    });
  }

  if (input.patternTerms && input.patternTerms.length > 0 && repo.searchByPattern) {
    const hits = repo.searchByPattern(input.patternTerms, keywordPoolSize, {
      where: valueWhere,
    });
    hits.forEach((hit, idx) => {
      const existing = blended.get(hit.id);
      if (existing) {
        existing.channels.push({ channel: "pattern", rank: idx, score: 1 / (idx + 1) });
        existing.cosine = Math.max(existing.cosine, hit.score);
      } else {
        blended.set(hit.id, {
          cosine: 0,
          vec: input.queryVec,
          channels: [{ channel: "pattern", rank: idx, score: 1 / (idx + 1) }],
        });
      }
    });
  }

  const out: SubEpisodeCandidate[] = [];
  for (const [id, hit] of blended) {
    const row = repo.getById(id);
    if (!row) continue;
    out.push({
      tier: "tier2",
      refKind: "sub_episode",
      refId: row.id,
      cosine: hit.cosine,
      ts: row.endTs,
      vec: hit.vec,
      channels: hit.channels,
      episodeId: row.episodeId,
      sessionId: row.sessionId,
      traceIds: row.traceIds as TraceId[],
      localGoal: row.localGoal,
      trigger: row.trigger,
      actionChain: row.actionChain,
      observations: row.observations,
      outcome: row.outcome,
      verification: row.verification,
      failureMode: row.failureMode,
      summary: row.summary,
      reflection: row.reflection,
      value: row.value,
      priority: row.priority,
      learnabilityScore: row.learnabilityScore,
      tags: row.tags,
    });
  }
  return out
    .sort((a, b) => b.priority - a.priority || b.cosine - a.cosine)
    .slice(0, deps.config.tier2TopK);
}

function resolveTagFilter(tags: readonly string[], config: RetrievalConfig): readonly string[] | undefined {
  if (config.tagFilter === "off") return undefined;
  if (!tags || tags.length === 0) return undefined;
  return tags;
}
