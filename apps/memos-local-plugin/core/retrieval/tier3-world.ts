/**
 * Tier 3 — World-Model retrieval (V7 §2.6 §3.1).
 *
 * Three channels mirror Tier 2:
 *
 *   - vec       — cosine over `world_model.vec`
 *   - fts       — FTS5 trigram MATCH on `world_model_fts(title, body, domain_tags)`
 *   - pattern   — LIKE %term% fallback for short / CJK queries
 *
 * Multi-channel matches get an RRF lift in `ranker.ts`. World models are
 * rare (user-scale), so total cost stays bounded even with three channels.
 */

import { rootLogger } from "../logger/index.js";
import type { EmbeddingVector, WorldModelId } from "../types.js";
import type {
  ChannelRank,
  RetrievalChannel,
  RetrievalConfig,
  RetrievalEmbedder,
  RetrievalRepos,
  WorldModelCandidate,
} from "./types.js";

const log = rootLogger.child({ channel: "core.retrieval.tier3" });
const DEFAULT_KEYWORD_TOPK = 20;

export interface Tier3Deps {
  repos: Pick<RetrievalRepos, "worldModel">;
  embedder?: RetrievalEmbedder;
  config: RetrievalConfig;
}

export interface Tier3Input {
  queryVec: EmbeddingVector | null;
  ftsMatch?: string | null;
  patternTerms?: readonly string[];
}

interface CandidateState {
  cosine: number;
  channels: ChannelRank[];
  meta?: { title: string };
  vec: EmbeddingVector | null;
}

export async function runTier3(
  deps: Tier3Deps,
  input: Tier3Input,
): Promise<WorldModelCandidate[]> {
  const { repos, config } = deps;
  const startedAt = Date.now();
  try {
    const haveVec = !!input.queryVec && input.queryVec.length > 0;
    const haveFts = !!input.ftsMatch && !!repos.worldModel.searchByText;
    const havePattern =
      !!input.patternTerms && input.patternTerms.length > 0 && !!repos.worldModel.searchByPattern;
    if (!haveVec && !haveFts && !havePattern) return [];

    const vecPoolSize = Math.max(
      config.tier3TopK,
      Math.ceil(config.tier3TopK * config.candidatePoolFactor),
    );
    const keywordPoolSize = Math.max(
      config.tier3TopK,
      config.keywordTopK ?? DEFAULT_KEYWORD_TOPK,
    );
    const worldMinSim = Math.min(config.minTraceSim, 0.15);
    const merged = new Map<WorldModelId, CandidateState>();

    if (haveVec) {
      const hits = repos.worldModel.searchByVector(input.queryVec!, vecPoolSize);
      hits.forEach((h, idx) => {
        if (h.score < worldMinSim) return;
        upsert(merged, h.id as WorldModelId, {
          cosine: h.score,
          channel: "vec",
          rank: idx,
          score: h.score,
          meta: h.meta,
          vec: input.queryVec!,
        });
      });
    }
    if (haveFts) {
      const hits = repos.worldModel.searchByText!(input.ftsMatch!, keywordPoolSize);
      hits.forEach((h, idx) => {
        upsert(merged, h.id as WorldModelId, {
          cosine: 0,
          channel: "fts",
          rank: idx,
          score: h.score,
          meta: h.meta,
          vec: input.queryVec ?? null,
        });
      });
    }
    if (havePattern) {
      const hits = repos.worldModel.searchByPattern!(input.patternTerms!, keywordPoolSize);
      hits.forEach((h, idx) => {
        upsert(merged, h.id as WorldModelId, {
          cosine: 0,
          channel: "pattern",
          rank: idx,
          score: h.score,
          meta: h.meta,
          vec: input.queryVec ?? null,
        });
      });
    }

    if (merged.size === 0) {
      log.info("done", {
        candidates: 0,
        kept: 0,
        latencyMs: Date.now() - startedAt,
      });
      return [];
    }

    const kept: WorldModelCandidate[] = [];
    for (const [id, state] of merged) {
      const wm = repos.worldModel.getById(id);
      if (!wm) continue;
      kept.push({
        tier: "tier3",
        refKind: "world-model",
        refId: wm.id,
        cosine: state.cosine,
        ts: Date.now(),
        vec: state.vec,
        title: wm.title,
        body: wm.body,
        policyIds: wm.policyIds ?? [],
        channels: state.channels,
      });
    }

    kept.sort((a, b) => bestChannelScore(b) - bestChannelScore(a));
    const trimmed = kept.slice(0, vecPoolSize);

    log.info("done", {
      candidates: merged.size,
      kept: trimmed.length,
      channels: { vec: haveVec, fts: haveFts, pattern: havePattern },
      latencyMs: Date.now() - startedAt,
    });
    return trimmed;
  } catch (err) {
    log.error("failed", {
      err: { message: err instanceof Error ? err.message : String(err) },
      latencyMs: Date.now() - startedAt,
    });
    return [];
  }
}

function upsert(
  into: Map<WorldModelId, CandidateState>,
  id: WorldModelId,
  patch: {
    cosine: number;
    channel: RetrievalChannel;
    rank: number;
    score: number;
    meta?: { title: string };
    vec: EmbeddingVector | null;
  },
): void {
  const entry = into.get(id);
  if (!entry) {
    into.set(id, {
      cosine: patch.cosine,
      channels: [{ channel: patch.channel, rank: patch.rank, score: patch.score }],
      meta: patch.meta,
      vec: patch.vec,
    });
    return;
  }
  entry.channels.push({ channel: patch.channel, rank: patch.rank, score: patch.score });
  if (patch.cosine > entry.cosine) entry.cosine = patch.cosine;
  if (!entry.vec && patch.vec) entry.vec = patch.vec;
}

function bestChannelScore(c: WorldModelCandidate): number {
  const channels = c.channels ?? [];
  if (channels.length === 0) return c.cosine;
  return channels.reduce((m, ch) => Math.max(m, ch.score), c.cosine);
}
