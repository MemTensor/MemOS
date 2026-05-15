import type { EpisodeId, PolicyId, TraceId } from "../../types.js";
import { buildInClause } from "../tx.js";
import type { StorageDb } from "../types.js";

export interface TracePolicyEpisodeLink {
  episodeId: EpisodeId;
  policyId: PolicyId;
  linkedAt: number;
}

export function makeTracePolicyLinksRepo(db: StorageDb) {
  const insert = db.prepare<{
    trace_id: TraceId;
    policy_id: PolicyId;
    episode_id: EpisodeId;
    created_at: number;
  }>(
    `INSERT OR IGNORE INTO trace_policy_links
       (trace_id, policy_id, episode_id, created_at)
     VALUES (@trace_id, @policy_id, @episode_id, @created_at)`,
  );
  const selectTraceIds = db.prepare<{ policy_id: PolicyId }, { trace_id: TraceId }>(
    `SELECT trace_id
       FROM trace_policy_links
      WHERE policy_id=@policy_id
      ORDER BY created_at DESC, trace_id DESC`,
  );
  const selectEpisodeIds = db.prepare<{ policy_id: PolicyId }, { episode_id: EpisodeId }>(
    `SELECT DISTINCT episode_id
       FROM trace_policy_links
      WHERE policy_id=@policy_id
      ORDER BY episode_id`,
  );
  const selectEpisodes = db.prepare<
    { policy_id: PolicyId },
    { episode_id: EpisodeId; policy_id: PolicyId; linked_at: number }
  >(
    `SELECT episode_id, policy_id, MAX(created_at) AS linked_at
       FROM trace_policy_links
      WHERE policy_id=@policy_id
      GROUP BY episode_id, policy_id
      ORDER BY linked_at DESC, episode_id DESC`,
  );

  return {
    link(args: {
      traceId: TraceId;
      policyId: PolicyId;
      episodeId: EpisodeId;
      now?: number;
    }): void {
      insert.run({
        trace_id: args.traceId,
        policy_id: args.policyId,
        episode_id: args.episodeId,
        created_at: args.now ?? Date.now(),
      });
    },

    getWithTraceIds(policyId: PolicyId): TraceId[] {
      return selectTraceIds.all({ policy_id: policyId }).map((r) => r.trace_id);
    },

    getLinkedEpisodeIds(policyId: PolicyId): EpisodeId[] {
      return selectEpisodeIds.all({ policy_id: policyId }).map((r) => r.episode_id);
    },

    getLinkedEpisodes(policyId: PolicyId): TracePolicyEpisodeLink[] {
      return selectEpisodes.all({ policy_id: policyId }).map(mapEpisodeLink);
    },

    getLinksForEpisodes(episodeIds: readonly EpisodeId[]): TracePolicyEpisodeLink[] {
      if (episodeIds.length === 0) return [];
      const placeholders = buildInClause(episodeIds.length);
      return db
        .prepare<readonly string[], { episode_id: EpisodeId; policy_id: PolicyId; linked_at: number }>(
          `SELECT episode_id, policy_id, MAX(created_at) AS linked_at
             FROM trace_policy_links
            WHERE episode_id ${placeholders}
            GROUP BY episode_id, policy_id
            ORDER BY linked_at DESC, episode_id DESC`,
        )
        .all(episodeIds)
        .map(mapEpisodeLink);
    },
  };
}

function mapEpisodeLink(row: {
  episode_id: EpisodeId;
  policy_id: PolicyId;
  linked_at: number;
}): TracePolicyEpisodeLink {
  return {
    episodeId: row.episode_id,
    policyId: row.policy_id,
    linkedAt: row.linked_at,
  };
}
