import type { RecallEngine } from "../recall/engine";
import type { ToolDefinition } from "../types";

function resolveOwnerFilter(owner: unknown): string[] {
  const resolvedOwner = typeof owner === "string" && owner.trim().length > 0 ? owner : "agent:main";
  return resolvedOwner === "public" ? ["public"] : [resolvedOwner, "public"];
}

export function createMemorySearchTool(engine: RecallEngine): ToolDefinition {
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
      },
    },
    handler: async (input) => {
      const result = await engine.search({
        query: (input.query as string) ?? "",
        maxResults: input.maxResults as number | undefined,
        minScore: input.minScore as number | undefined,
        ownerFilter: resolveOwnerFilter(input.owner),
      });
      return result;
    },
  };
}
