import { rootLogger } from "../logger/index.js";
import type { EmbeddingVector, PolicyId } from "../types.js";
import type {
  ChannelRank,
  ExperienceCandidate,
  RetrievalChannel,
  RetrievalConfig,
  RetrievalRepos,
} from "./types.js";

const log = rootLogger.child({ channel: "core.retrieval.tier2.experience" });
const DEFAULT_KEYWORD_TOPK = 20;

export interface Tier2ExperienceDeps {
  repos: Pick<RetrievalRepos, "policies">;
  config: RetrievalConfig;
}

export interface Tier2ExperienceInput {
  queryVec: EmbeddingVector | null;
  ftsMatch?: string | null;
  patternTerms?: string[];
}

export async function runTier2Experience(
  deps: Tier2ExperienceDeps,
  input: Tier2ExperienceInput,
): Promise<ExperienceCandidate[]> {
  const startedAt = Date.now();
  const repo = deps.repos.policies;
  if (!repo) {
    return [];
  }

  try {
    const vecPoolSize = Math.max(
      deps.config.tier2TopK,
      Math.ceil(deps.config.tier2TopK * deps.config.candidatePoolFactor),
    );
    const keywordPoolSize = Math.max(
      deps.config.tier2TopK,
      deps.config.keywordTopK ?? DEFAULT_KEYWORD_TOPK,
    );
    const statusIn: Array<"active" | "candidate"> = ["active", "candidate"];
    const haveVec = !!repo.searchByVector && !!input.queryVec && input.queryVec.length > 0;
    const haveFts = !!input.ftsMatch && !!repo.searchByText;
    const havePattern =
      !!input.patternTerms && input.patternTerms.length > 0 && !!repo.searchByPattern;
    if (!haveVec && !haveFts && !havePattern) {
      return [];
    }

    const merged = new Map<PolicyId, CandidateState>();
    if (haveVec) {
      const hits = repo.searchByVector!(input.queryVec!, vecPoolSize, {
        statusIn,
        hardCap: Math.max(50, vecPoolSize * 5),
      });
      hits.forEach((hit, idx) => {
        if (hit.score < deps.config.minTraceSim) return;
        upsertCandidate(merged, hit.id as PolicyId, {
          cosine: hit.score,
          channel: "vec",
          rank: idx,
          score: hit.score,
          vec: input.queryVec!,
        });
      });
    }

    if (haveFts) {
      const hits = repo.searchByText!(input.ftsMatch!, keywordPoolSize, { statusIn });
      hits.forEach((hit, idx) => {
        upsertCandidate(merged, hit.id as PolicyId, {
          cosine: 0,
          channel: "fts",
          rank: idx,
          score: hit.score,
          vec: input.queryVec ?? null,
        });
      });
    }

    if (havePattern) {
      const hits = repo.searchByPattern!(input.patternTerms!, keywordPoolSize, { statusIn });
      hits.forEach((hit, idx) => {
        upsertCandidate(merged, hit.id as PolicyId, {
          cosine: 0,
          channel: "pattern",
          rank: idx,
          score: hit.score,
          vec: input.queryVec ?? null,
        });
      });
    }

    const out: ExperienceCandidate[] = [];
    for (const [id, state] of merged) {
      const row = repo.getById(id);
      if (!row) continue;
      if ((row.sourceFeedbackIds?.length ?? 0) === 0) continue;
      const status = row.status ?? "candidate";
      if (status === "archived") continue;
      out.push({
        tier: "tier2",
        refKind: "experience",
        refId: row.id as PolicyId,
        cosine: state.cosine,
        ts: row.updatedAt ?? Date.now(),
        vec: row.vec ?? state.vec,
        channels: state.channels,
        title: row.title,
        trigger: row.trigger ?? "",
        procedure: row.procedure ?? "",
        verification: row.verification ?? "",
        boundary: row.boundary ?? "",
        support: row.support ?? 1,
        gain: row.gain ?? 0,
        status,
        experienceType: row.experienceType ?? "success_pattern",
        evidencePolarity: row.evidencePolarity ?? "positive",
        salience: row.salience ?? 0,
        confidence: row.confidence ?? 0.5,
        skillEligible: row.skillEligible !== false,
        sourceEpisodeIds: row.sourceEpisodeIds ?? [],
        sourceFeedbackIds: row.sourceFeedbackIds ?? [],
        sourceTraceIds: row.sourceTraceIds ?? [],
        decisionGuidance: row.decisionGuidance,
        updatedAt: row.updatedAt ?? Date.now(),
        debug: {
          matchedChannels: state.channels.map((c) => c.channel),
          experienceType: row.experienceType ?? "success_pattern",
          evidencePolarity: row.evidencePolarity ?? "positive",
        },
      });
    }
    out.sort((a, b) => bestChannelScore(b) - bestChannelScore(a));
    const trimmed = out.slice(0, vecPoolSize);
    log.info("done", {
      candidates: merged.size,
      kept: trimmed.length,
      channels: {
        vec: haveVec,
        fts: haveFts,
        pattern: havePattern,
      },
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

interface CandidateState {
  cosine: number;
  channels: ChannelRank[];
  vec: EmbeddingVector | null;
}

function upsertCandidate(
  map: Map<PolicyId, CandidateState>,
  id: PolicyId,
  hit: {
    cosine: number;
    channel: RetrievalChannel;
    rank: number;
    score: number;
    vec: EmbeddingVector | null;
  },
): void {
  const curr = map.get(id);
  const channel: ChannelRank = {
    channel: hit.channel,
    rank: hit.rank,
    score: hit.score,
  };
  if (!curr) {
    map.set(id, {
      cosine: hit.cosine,
      channels: [channel],
      vec: hit.vec,
    });
    return;
  }
  curr.cosine = Math.max(curr.cosine, hit.cosine);
  curr.channels.push(channel);
  if (!curr.vec && hit.vec) curr.vec = hit.vec;
}

function bestChannelScore(c: ExperienceCandidate): number {
  let best = c.cosine;
  for (const ch of c.channels ?? []) {
    if (ch.score > best) best = ch.score;
  }
  return best;
}
