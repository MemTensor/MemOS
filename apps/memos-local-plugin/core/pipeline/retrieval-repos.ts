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
      getById(id) {
        const row = repos.skills.getById(id);
        if (!row || !isVisibleTo(row, namespace)) return null;
        return {
          id: row.id,
          name: row.name,
          status: row.status,
          invocationGuide: row.invocationGuide,
          eta: row.eta,
          sourcePolicyIds: row.sourcePolicyIds,
          updatedAt: row.updatedAt,
        };
      },
    },

    traces: {
      searchByVector(query, k, opts) {
        return repos.traces.searchByVector(query, k, opts ?? {});
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
      searchByVector(query, k, opts) {
        return repos.policies.searchByVector(query, k, opts ?? {});
      },
      list(filter) {
        const rows = repos.policies.list(
          filter && filter.status ? { status: filter.status } : {},
        );
        return rows.filter((r) => isVisibleTo(r, namespace)).map((r) => ({
          id: r.id,
          title: r.title,
          trigger: r.trigger,
          procedure: r.procedure,
          verification: r.verification,
          boundary: r.boundary,
          support: r.support,
          gain: r.gain,
          status: r.status,
          experienceType: r.experienceType ?? "success_pattern",
          evidencePolarity: r.evidencePolarity ?? "positive",
          salience: r.salience ?? 0,
          confidence: r.confidence ?? 0.5,
          skillEligible: r.skillEligible !== false,
          sourceEpisodeIds: r.sourceEpisodeIds,
          sourceFeedbackIds: r.sourceFeedbackIds ?? [],
          sourceTraceIds: r.sourceTraceIds ?? [],
          decisionGuidance: r.decisionGuidance,
          vec: r.vec,
          updatedAt: r.updatedAt,
        }));
      },
      getById(id) {
        const row = repos.policies.getById(id);
        if (!row || !isVisibleTo(row, namespace)) return null;
        return {
          id: row.id,
          title: row.title,
          trigger: row.trigger,
          procedure: row.procedure,
          verification: row.verification,
          boundary: row.boundary,
          support: row.support,
          gain: row.gain,
          status: row.status,
          experienceType: row.experienceType ?? "success_pattern",
          evidencePolarity: row.evidencePolarity ?? "positive",
          salience: row.salience ?? 0,
          confidence: row.confidence ?? 0.5,
          skillEligible: row.skillEligible !== false,
          sourceEpisodeIds: row.sourceEpisodeIds,
          sourceFeedbackIds: row.sourceFeedbackIds ?? [],
          sourceTraceIds: row.sourceTraceIds ?? [],
          decisionGuidance: row.decisionGuidance,
          vec: row.vec,
          updatedAt: row.updatedAt,
        };
      },
    },
  };
}
