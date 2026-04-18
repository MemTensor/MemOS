import { hubSearchMemories } from "../client/hub";
import type { HubScope, HubSearchResult } from "../sharing/types";
import type { RecallEngine } from "../recall/engine";
import type { PluginContext, ToolDefinition } from "../types";
import type { SqliteStore } from "../storage/sqlite";

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

export function createMemorySearchTool(engine: RecallEngine, store?: SqliteStore, ctx?: PluginContext, sharedState?: { lastSearchTime: number }): ToolDefinition {
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

      const localSearch = engine.search({
        query,
        maxResults,
        minScore,
        ownerFilter,
      });

      if (scope === "local" || !store || !ctx) {
        return localSearch;
      }

      const [local, hub] = await Promise.all([
        localSearch,
        hubSearchMemories(store, ctx, { query, maxResults, scope, hubAddress: input.hubAddress as string | undefined, userToken: input.userToken as string | undefined }).catch((err) => {
          ctx.log.warn(`Hub search failed, using local-only results: ${err}`);
          return emptyHubResult(scope);
        }),
      ]);

      return { local, hub };
    },
  };
}
