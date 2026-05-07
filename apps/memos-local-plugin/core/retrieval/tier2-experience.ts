import { rootLogger } from "../logger/index.js";
import type { EmbeddingVector, PolicyId } from "../types.js";
import type {
  ChannelRank,
  ExperienceCandidate,
  RetrievalConfig,
  RetrievalRepos,
} from "./types.js";

const log = rootLogger.child({ channel: "core.retrieval.tier2.experience" });

export interface Tier2ExperienceDeps {
  repos: Pick<RetrievalRepos, "policies">;
  config: RetrievalConfig;
}

export interface Tier2ExperienceInput {
  queryVec: EmbeddingVector | null;
}

export async function runTier2Experience(
  deps: Tier2ExperienceDeps,
  input: Tier2ExperienceInput,
): Promise<ExperienceCandidate[]> {
  const startedAt = Date.now();
  const repo = deps.repos.policies;
  if (!repo?.searchByVector || !input.queryVec || input.queryVec.length === 0) {
    return [];
  }

  try {
    const poolSize = Math.max(
      deps.config.tier2TopK,
      Math.ceil(deps.config.tier2TopK * deps.config.candidatePoolFactor),
    );
    const hits = repo.searchByVector(input.queryVec, poolSize, {
      statusIn: ["active", "candidate"],
      hardCap: Math.max(50, poolSize * 5),
    });
    const out: ExperienceCandidate[] = [];
    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i]!;
      if (hit.score < deps.config.minTraceSim) continue;
      const row = repo.getById(hit.id as PolicyId);
      if (!row) continue;
      if ((row.sourceFeedbackIds?.length ?? 0) === 0) continue;
      const status = row.status ?? "candidate";
      if (status === "archived") continue;
      const channels: ChannelRank[] = [
        { channel: "vec", rank: i, score: hit.score },
      ];
      out.push({
        tier: "tier2",
        refKind: "experience",
        refId: row.id as PolicyId,
        cosine: hit.score,
        ts: row.updatedAt ?? Date.now(),
        vec: row.vec ?? input.queryVec,
        channels,
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
          matchedChannels: channels.map((c) => c.channel),
          experienceType: row.experienceType ?? "success_pattern",
          evidencePolarity: row.evidencePolarity ?? "positive",
        },
      });
    }
    log.info("done", {
      candidates: hits.length,
      kept: out.length,
      latencyMs: Date.now() - startedAt,
    });
    return out;
  } catch (err) {
    log.error("failed", {
      err: { message: err instanceof Error ? err.message : String(err) },
      latencyMs: Date.now() - startedAt,
    });
    return [];
  }
}
