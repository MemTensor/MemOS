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
import type { RuntimeNamespace, TraceId } from "../../agent-contract/dto.js";
import { isVisibleTo } from "../runtime/namespace.js";

export function wrapRetrievalRepos(repos: Repos, namespace: RuntimeNamespace): RetrievalRepos {
  return {
    skills: {
      searchByVector(query, k, opts) {
        return repos.skills.searchByVector(query, k, opts ?? {});
      },
      searchByText(ftsMatch, k, opts) {
        return repos.skills.searchByText(ftsMatch, k, opts ?? {});
      },
      searchByPattern(terms, k, opts) {
        return repos.skills.searchByPattern(terms, k, opts ?? {});
      },
      getById(id) {
        const row = repos.skills.getById(id);
        if (!row || !isVisibleTo(row, namespace)) return null;
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
      searchByText(ftsMatch, k, opts) {
        return repos.traces.searchByText(ftsMatch, k, opts ?? {});
      },
      searchByPattern(terms, k, opts) {
        return repos.traces.searchByPattern(terms, k, opts ?? {});
      },
      getManyByIds(ids) {
        const rows = repos.traces.getManyByIds(ids as readonly TraceId[]);
        return rows.filter((r) => isVisibleTo(r, namespace)).map((r) => ({
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
        return rows.filter((r) => isVisibleTo(r, namespace)).map((r) => ({
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
      searchByText(ftsMatch, k) {
        return repos.worldModel.searchByText(ftsMatch, k);
      },
      searchByPattern(terms, k) {
        return repos.worldModel.searchByPattern(terms, k);
      },
      getById(id) {
        const row = repos.worldModel.getById(id);
        if (!row || !isVisibleTo(row, namespace)) return null;
        return {
          id: row.id,
          title: row.title,
          body: row.body,
          policyIds: row.policyIds,
        };
      },
    },

    // V7 §2.4.6 — expose just enough of the policies repo for retrieval
    // to look up `decisionGuidance` (preference / anti-pattern) attached
    // to traces / skills already chosen by tiers 1 + 2.
    policies: {
      list(filter) {
        const rows = repos.policies.list(
          filter && filter.status ? { status: filter.status } : {},
        );
        return rows.filter((r) => isVisibleTo(r, namespace)).map((r) => ({
          id: r.id,
          title: r.title,
          sourceEpisodeIds: r.sourceEpisodeIds,
          decisionGuidance: r.decisionGuidance,
        }));
      },
      getById(id) {
        const row = repos.policies.getById(id);
        if (!row || !isVisibleTo(row, namespace)) return null;
        return {
          id: row.id,
          title: row.title,
          sourceEpisodeIds: row.sourceEpisodeIds,
          decisionGuidance: row.decisionGuidance,
        };
      },
    },
  };
}
