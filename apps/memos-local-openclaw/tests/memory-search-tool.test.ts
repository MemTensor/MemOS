import { describe, it, expect, vi } from "vitest";
import { createMemorySearchTool } from "../src/tools/memory-search";
import type { RecallEngine } from "../src/recall/engine";

function makeMockEngine() {
  return {
    search: vi.fn(async () => ({
      hits: [],
      meta: { usedMinScore: 0.45, usedMaxResults: 6, totalCandidates: 0 },
    })),
  } as unknown as RecallEngine;
}

describe("memory_search tool — excludeSessionKey input wiring", () => {
  it("declares excludeSessionKey in its inputSchema", () => {
    const engine = makeMockEngine();
    const tool = createMemorySearchTool(engine);
    const schema = tool.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("excludeSessionKey");
  });

  it("forwards excludeSessionKey from tool input to engine.search", async () => {
    const engine = makeMockEngine();
    const tool = createMemorySearchTool(engine);

    await tool.handler({ query: "deploy", excludeSessionKey: "sess-current" });

    expect(engine.search).toHaveBeenCalledTimes(1);
    const callArgs = (engine.search as unknown as { mock: { calls: any[][] } }).mock.calls[0][0];
    expect(callArgs.excludeSessionKey).toBe("sess-current");
  });

  it("omits excludeSessionKey when not provided", async () => {
    const engine = makeMockEngine();
    const tool = createMemorySearchTool(engine);

    await tool.handler({ query: "deploy" });

    const callArgs = (engine.search as unknown as { mock: { calls: any[][] } }).mock.calls[0][0];
    expect(callArgs.excludeSessionKey).toBeUndefined();
  });

  it("treats non-string excludeSessionKey as undefined (input hygiene)", async () => {
    const engine = makeMockEngine();
    const tool = createMemorySearchTool(engine);

    await tool.handler({ query: "deploy", excludeSessionKey: 42 });

    const callArgs = (engine.search as unknown as { mock: { calls: any[][] } }).mock.calls[0][0];
    expect(callArgs.excludeSessionKey).toBeUndefined();
  });
});
