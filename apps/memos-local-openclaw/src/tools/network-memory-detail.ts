import { hubGetMemoryDetail } from "../client/hub";
import type { PluginContext, ToolDefinition } from "../types";
import type { SqliteStore } from "../storage/sqlite";

export function createNetworkMemoryDetailTool(store: SqliteStore, ctx: PluginContext): ToolDefinition {
  return {
    name: "network_memory_detail",
    description:
      "Fetch the full detail for one Hub search hit using its remoteHitId. Use this after memory_search(scope=group|all) when you need the full shared content.",
    inputSchema: {
      type: "object",
      properties: {
        remoteHitId: {
          type: "string",
          description: "The remoteHitId returned by memory_search hub results.",
        },
        hubAddress: {
          type: "string",
          description: "Optional hub address override for integration tests or manual routing.",
        },
        userToken: {
          type: "string",
          description: "Optional hub bearer token override for integration tests.",
        },
      },
      required: ["remoteHitId"],
    },
    handler: async (input) => hubGetMemoryDetail(store, ctx, {
      remoteHitId: String(input.remoteHitId ?? ""),
      hubAddress: input.hubAddress as string | undefined,
      userToken: input.userToken as string | undefined,
    }),
  };
}
