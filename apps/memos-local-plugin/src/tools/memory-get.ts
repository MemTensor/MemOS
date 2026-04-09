import type { SqliteStore } from "../storage/sqlite";
import type { ToolDefinition, GetResult, ChunkRef } from "../types";
import { DEFAULTS } from "../types";

function resolveOwnerFilter(owner: unknown): string[] {
  const resolvedOwner = typeof owner === "string" && owner.trim().length > 0 ? owner : "agent:main";
  return resolvedOwner === "public" ? ["public"] : [resolvedOwner, "public"];
}

export function createMemoryGetTool(store: SqliteStore): ToolDefinition {
  return {
    name: "memory_get",
    description:
      "Retrieve the full original text of a specific memory chunk. Use after memory_search or memory_timeline " +
      "when you need to see the complete content (not just the excerpt). Useful for verifying exact details.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "object",
          description: "Reference object from a memory_search hit or memory_timeline entry.",
          properties: {
            sessionKey: { type: "string" },
            chunkId: { type: "string" },
            turnId: { type: "string" },
            seq: { type: "number" },
          },
          required: ["sessionKey", "chunkId", "turnId", "seq"],
        },
        maxChars: {
          type: "number",
          description: `Maximum characters to return (default ${DEFAULTS.getMaxCharsDefault}, max ${DEFAULTS.getMaxCharsMax}).`,
        },
      },
      required: ["ref"],
    },
    handler: async (input) => {
      const ref = input.ref as ChunkRef;
      const maxChars = Math.min(
        (input.maxChars as number) ?? DEFAULTS.getMaxCharsDefault,
        DEFAULTS.getMaxCharsMax,
      );

      const chunk = store.getChunksByRef(ref, resolveOwnerFilter(input.owner));

      if (!chunk) {
        return { error: `Chunk not found: ${ref.chunkId}` };
      }

      let content = chunk.content;
      if (content.length > maxChars) {
        content = content.slice(0, maxChars) + "…";
      }

      const result: GetResult = {
        content,
        ref: {
          sessionKey: chunk.sessionKey,
          chunkId: chunk.id,
          turnId: chunk.turnId,
          seq: chunk.seq,
        },
        source: {
          ts: chunk.createdAt,
          role: chunk.role,
          sessionKey: chunk.sessionKey,
        },
      };

      return result;
    },
  };
}
