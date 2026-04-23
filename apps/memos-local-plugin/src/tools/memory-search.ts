import { hubSearchMemories } from "../client/hub";
import type { HubScope, HubSearchResult } from "../sharing/types";
import type { RecallEngine } from "../recall/engine";
import type { PluginContext, ToolDefinition, SearchHit } from "../types";
import type { SqliteStore } from "../storage/sqlite";
import type { Summarizer } from "../ingest/providers";

function resolveOwnerFilter(owner: unknown): string[] {
  const resolvedOwner = typeof owner === "string" && owner.trim().length > 0 ? owner : "agent:main";
  return resolvedOwner === "public" ? ["public"] : [resolvedOwner, "public"];
}

function resolveScope(scope: unknown): HubScope {
  return scope === "group" || scope === "all" ? scope : "local";
}

function emptyHubResult(scope: HubScope): HubSearchResult {
  return {
    hits: [],
    meta: {
      totalCandidates: 0,
      searchedGroups: [],
      includedPublic: scope === "all",
    },
  };
}

function deduplicateHits<T extends { summary: string }>(hits: T[]): T[] {
  const kept: T[] = [];
  for (const hit of hits) {
    const dominated = kept.some((k) => {
      const a = k.summary.toLowerCase();
      const b = hit.summary.toLowerCase();
      if (a === b) return true;
      const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 1));
      const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 1));
      if (wordsA.size === 0 || wordsB.size === 0) return false;
      let overlap = 0;
      for (const w of wordsB) { if (wordsA.has(w)) overlap++; }
      return overlap / Math.min(wordsA.size, wordsB.size) > 0.7;
    });
    if (!dominated) kept.push(hit);
  }
  return kept;
}

export function createMemorySearchTool(engine: RecallEngine, store?: SqliteStore, ctx?: PluginContext, sharedState?: { lastSearchTime: number }, summarizer?: Summarizer): ToolDefinition {
  return {
    name: "memory_search",
    description:
      "Search stored conversation memories. Returns matching entries with summary, original_excerpt (evidence), score, and ref for follow-up with memory_timeline or memory_get. " +
      "Default: top 6 results, minScore 0.45. Increase maxResults to 12/20 or lower minScore to 0.35 if initial results are insufficient.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query. Include specific entities, commands, or error messages for better recall.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results (default 6, max 20).",
        },
        minScore: {
          type: "number",
          description: "Minimum relevance score threshold 0-1 (default 0.45, floor 0.35).",
        },
        scope: {
          type: "string",
          description: "Search scope: local (default), group, or all. Group/all return split local and hub sections.",
        },
        hubAddress: {
          type: "string",
          description: "Optional hub address override for group/all search, integration tests, or manual routing.",
        },
        userToken: {
          type: "string",
          description: "Optional hub bearer token override for group/all search or integration tests.",
        },
      },
    },
    handler: async (input) => {
      if (sharedState) sharedState.lastSearchTime = Date.now();
      const query = (input.query as string) ?? "";
      const maxResults = input.maxResults as number | undefined;
      const minScore = input.minScore as number | undefined;
      const ownerFilter = resolveOwnerFilter(input.owner);
      const scope = resolveScope(input.scope);
      const log = ctx?.log;

      const localSearch = engine.search({
        query,
        maxResults,
        minScore,
        ownerFilter,
      });

      if (scope === "local" || !store || !ctx) {
        const result = await localSearch;

        if (!summarizer || result.hits.length === 0) {
          return result;
        }

        const candidates = result.hits.map((h, i) => ({
          index: i + 1,
          role: h.source.role,
          content: (h.original_excerpt ?? "").slice(0, 300),
          time: h.source.ts ? new Date(h.source.ts).toISOString().slice(0, 16) : "",
        }));

        let filteredHits = result.hits;
        try {
          const filterResult = await summarizer.filterRelevant(query, candidates);
          if (filterResult !== null) {
            if (filterResult.relevant.length > 0) {
              const relevantSet = new Set(filterResult.relevant);
              filteredHits = result.hits.filter((_, i) => relevantSet.has(i + 1));
              log?.debug(`memory_search LLM filter: ${result.hits.length} → ${filteredHits.length}`);
            } else {
              filteredHits = [];
            }
          }
        } catch (err) {
          log?.warn(`memory_search LLM filter failed, returning unfiltered: ${err}`);
        }

        filteredHits = deduplicateHits(filteredHits);

        return {
          hits: filteredHits,
          meta: result.meta,
          details: {
            candidates: result.hits.map((h) => ({
              chunkId: h.ref.chunkId,
              role: h.source.role,
              score: h.score,
              summary: h.summary,
              original_excerpt: (h.original_excerpt ?? "").slice(0, 200),
              origin: h.origin || "local",
              owner: h.owner || "",
            })),
            filtered: filteredHits.map((h) => ({
              chunkId: h.ref.chunkId,
              role: h.source.role,
              score: h.score,
              summary: h.summary,
              original_excerpt: (h.original_excerpt ?? "").slice(0, 200),
              origin: h.origin || "local",
              owner: h.owner || "",
            })),
          },
        };
      }

      const [local, hub] = await Promise.all([
        localSearch,
        hubSearchMemories(store, ctx, { query, maxResults, scope, hubAddress: input.hubAddress as string | undefined, userToken: input.userToken as string | undefined }).catch((err) => {
          ctx.log.warn(`Hub search failed, using local-only results: ${err}`);
          return emptyHubResult(scope);
        }),
      ]);

      if (!summarizer) {
        return { local, hub };
      }

      const allHitsForFilter = local.hits;
      const hubRemoteHits = hub?.hits ?? [];
      const mergedCandidates = [
        ...allHitsForFilter.map((h: SearchHit, i: number) => ({
          index: i + 1,
          role: h.source.role,
          content: (h.original_excerpt ?? "").slice(0, 300),
          time: h.source.ts ? new Date(h.source.ts).toISOString().slice(0, 16) : "",
        })),
        ...hubRemoteHits.map((h: any, i: number) => ({
          index: allHitsForFilter.length + i + 1,
          role: (h.source?.role || "assistant") as string,
          content: (h.summary || h.excerpt || "").slice(0, 300),
          time: h.source?.ts ? new Date(h.source.ts).toISOString().slice(0, 16) : "",
        })),
      ];

      let filteredLocalHits = allHitsForFilter;
      let filteredHubRemoteHits = hubRemoteHits;

      if (mergedCandidates.length > 0) {
        try {
          const filterResult = await summarizer.filterRelevant(query, mergedCandidates);
          if (filterResult !== null) {
            if (filterResult.relevant.length > 0) {
              const relevantSet = new Set(filterResult.relevant);
              const hubStartIdx = allHitsForFilter.length + 1;
              filteredLocalHits = allHitsForFilter.filter((_: SearchHit, i: number) => relevantSet.has(i + 1));
              filteredHubRemoteHits = hubRemoteHits.filter((_: any, i: number) => relevantSet.has(hubStartIdx + i));
              log?.debug(`memory_search LLM filter: merged ${mergedCandidates.length} → local ${filteredLocalHits.length}, hub ${filteredHubRemoteHits.length}`);
            } else {
              filteredLocalHits = [];
              filteredHubRemoteHits = [];
            }
          }
        } catch (err) {
          log?.warn(`memory_search LLM filter failed, returning unfiltered: ${err}`);
        }
      }

      filteredLocalHits = deduplicateHits(filteredLocalHits);

      return {
        local: { hits: filteredLocalHits, meta: local.meta },
        hub: { hits: filteredHubRemoteHits, meta: hub.meta },
        details: {
          candidates: allHitsForFilter.map((h: SearchHit) => ({
            chunkId: h.ref.chunkId,
            role: h.source.role,
            score: h.score,
            summary: h.summary,
            original_excerpt: (h.original_excerpt ?? "").slice(0, 200),
            origin: h.origin || "local",
            owner: h.owner || "",
          })),
          filtered: filteredLocalHits.map((h: SearchHit) => ({
            chunkId: h.ref.chunkId,
            role: h.source.role,
            score: h.score,
            summary: h.summary,
            original_excerpt: (h.original_excerpt ?? "").slice(0, 200),
            origin: h.origin || "local",
            owner: h.owner || "",
          })),
        },
      };
    },
  };
}
