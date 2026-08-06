import { describe, expect, it, vi } from "vitest";

import { RecallEngine } from "../src/recall/engine";
import type { Embedder } from "../src/embedding";
import type { SqliteStore } from "../src/storage/sqlite";
import type { PluginContext } from "../src/types";

describe("RecallEngine skill vector ranking", () => {
  it("sorts candidates by descending cosine score", async () => {
    const store = {
      skillFtsSearch: vi.fn(() => []),
      getSkillEmbeddings: vi.fn(() => [
        { skillId: "low", vector: [0, 1] },
        { skillId: "high", vector: [1, 0] },
      ]),
      getSkill: vi.fn((id: string) => ({
        id,
        name: id,
        description: id,
        owner: "agent:main",
        visibility: "private",
      })),
    } as unknown as SqliteStore;
    const embedder = {
      embedQueryWithCache: vi.fn(async () => [1, 0]),
      embedQuery: vi.fn(async () => [1, 0]),
    } as unknown as Embedder;
    const context = {
      stateDir: "/tmp",
      workspaceDir: "/tmp",
      config: {},
      log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as PluginContext;
    const engine = new RecallEngine(store, embedder, context);
    vi.spyOn(engine as any, "judgeSkillRelevance").mockResolvedValue([0, 1]);

    const results = await engine.searchSkills("query", "self", "agent:main");

    expect(results.map((result) => result.skillId)).toEqual(["high", "low"]);
  });
});
