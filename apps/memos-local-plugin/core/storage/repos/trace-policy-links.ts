import type { EpisodeId, PolicyId, TraceId } from "../../types.js";
import type { StorageDb } from "../types.js";

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
  };
}
