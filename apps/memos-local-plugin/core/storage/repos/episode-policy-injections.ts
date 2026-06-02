import type { EpisodeId, PolicyId } from "../../types.js";
import type { StorageDb } from "../types.js";

export function makeEpisodePolicyInjectionsRepo(db: StorageDb) {
  const insert = db.prepare<{
    episode_id: EpisodeId;
    policy_id: PolicyId;
    source: string | null;
    injected_at: number;
  }>(
    `INSERT OR IGNORE INTO episode_policy_injections
       (episode_id, policy_id, source, injected_at)
     VALUES (@episode_id, @policy_id, @source, @injected_at)`,
  );
  const selectPolicyIds = db.prepare<{ episode_id: EpisodeId }, { policy_id: PolicyId }>(
    `SELECT policy_id
       FROM episode_policy_injections
      WHERE episode_id = @episode_id
      ORDER BY injected_at DESC, policy_id DESC`,
  );

  return {
    inject(args: {
      episodeId: EpisodeId;
      policyId: PolicyId;
      source?: string | null;
      now?: number;
    }): void {
      insert.run({
        episode_id: args.episodeId,
        policy_id: args.policyId,
        source: args.source ?? null,
        injected_at: args.now ?? Date.now(),
      });
    },
    listPolicyIdsForEpisode(episodeId: EpisodeId): PolicyId[] {
      return selectPolicyIds.all({ episode_id: episodeId }).map((r) => r.policy_id);
    },
  };
}
