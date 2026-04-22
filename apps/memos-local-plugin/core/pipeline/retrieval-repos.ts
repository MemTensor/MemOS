/**
 * Adapter between the concrete storage `Repos` and the narrow
 * `RetrievalRepos` surface the retrieval pipeline consumes.
 *
 * Keeping this translation in `core/pipeline/` means the retrieval module
 * stays decoupled from the storage schema — and the pipeline stays the
 * one place where we remember which repo serves which tier.
 */

import type { RetrievalRepos } from "../retrieval/types.js";
import type { Repos } from "../storage/repos/index.js";
import type { TraceId } from "../../agent-contract/dto.js";

export function wrapRetrievalRepos(repos: Repos): RetrievalRepos {
  return {
    skills: {
      searchByVector(query, k, opts) {
        return repos.skills.searchByVector(query, k, opts ?? {});
      },
      getById(id) {
        const row = repos.skills.getById(id);
        if (!row) return null;
        return {
          id: row.id,
          name: row.name,
          status: row.status,
          invocationGuide: row.invocationGuide,
          eta: row.eta,
        };
      },
    },

    traces: {
      searchByVector(query, k, opts) {
        return repos.traces.searchByVector(query, k, opts ?? {});
      },
      getManyByIds(ids) {
        const rows = repos.traces.getManyByIds(ids as readonly TraceId[]);
        return rows.map((r) => ({
          id: r.id,
          episodeId: r.episodeId,
          sessionId: r.sessionId,
          ts: r.ts,
          userText: r.userText,
          agentText: r.agentText,
          reflection: r.reflection,
          value: r.value,
          priority: r.priority,
          tags: r.tags,
          vecSummary: r.vecSummary,
          vecAction: r.vecAction,
        }));
      },
      searchByErrorSignature(fragments, limit, opts) {
        const rows = repos.traces.searchByErrorSignature(fragments, limit, opts);
        return rows.map((r) => ({
          id: r.id,
          episodeId: r.episodeId,
          sessionId: r.sessionId,
          ts: r.ts,
          userText: r.userText,
          agentText: r.agentText,
          reflection: r.reflection,
          value: r.value,
          priority: r.priority,
          tags: r.tags,
          errorSignatures: r.errorSignatures ?? [],
        }));
      },
    },

    worldModel: {
      searchByVector(query, k, opts) {
        return repos.worldModel.searchByVector(query, k, opts ?? {});
      },
      getById(id) {
        const row = repos.worldModel.getById(id);
        if (!row) return null;
        return {
          id: row.id,
          title: row.title,
          body: row.body,
          policyIds: row.policyIds,
        };
      },
    },
  };
}
