import { describe, expect, it, vi } from "vitest";

import { registerCompatibilityRoutes } from "../../../server/routes/compatibility.js";
import { Routes } from "../../../server/routes/registry.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

function stubCore(): MemoryCore {
  return {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    health: vi.fn(async () => ({
      ok: true,
      version: "test",
      uptimeMs: 1,
      agent: "openclaw",
      paths: { home: "/tmp", config: "/tmp/c", db: "/tmp/db", skills: "/tmp/s", logs: "/tmp/l" },
      llm: { available: false, provider: "mock" },
      embedder: { available: false, provider: "mock", dim: 0 },
      skillEvolver: { available: false, provider: "mock", model: "mock", inherited: true },
    })),
    openSession: vi.fn(async () => "s1"),
    closeSession: vi.fn(async () => {}),
    openEpisode: vi.fn(async () => "e1"),
    closeEpisode: vi.fn(async () => {}),
    onTurnStart: vi.fn(async () => ({
      query: { agent: "openclaw", query: "" },
      hits: [],
      injectedContext: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    })),
    onTurnEnd: vi.fn(async () => ({ traceId: "t1", episodeId: "e1" })),
    submitFeedback: vi.fn(async (fb) => ({
      id: "fb1",
      ts: 1,
      channel: fb.channel,
      polarity: fb.polarity,
      magnitude: fb.magnitude,
      rationale: fb.rationale,
      raw: fb.raw,
      traceId: fb.traceId,
      episodeId: fb.episodeId,
    })),
    recordToolOutcome: vi.fn(),
    recordSubagentOutcome: vi.fn(async () => ({ traceId: "t1", episodeId: "e1" })),
    searchMemory: vi.fn(async () => ({
      query: { query: "" } as any,
      hits: [],
      injectedContext: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    })),
    getTrace: vi.fn(async () => null),
    updateTrace: vi.fn(async () => null),
    deleteTrace: vi.fn(async () => ({ deleted: false })),
    deleteTraces: vi.fn(async () => ({ deleted: 0 })),
    shareTrace: vi.fn(async () => null),
    getPolicy: vi.fn(async () => null),
    listPolicies: vi.fn(async () => []),
    countPolicies: vi.fn(async () => 0),
    setPolicyStatus: vi.fn(async () => null),
    deletePolicy: vi.fn(async () => ({ deleted: false })),
    sharePolicy: vi.fn(async () => null),
    updatePolicy: vi.fn(async () => null),
    editPolicyGuidance: vi.fn(async () => null),
    getWorldModel: vi.fn(async () => null),
    listWorldModels: vi.fn(async () => []),
    countWorldModels: vi.fn(async () => 0),
    deleteWorldModel: vi.fn(async () => ({ deleted: false })),
    shareWorldModel: vi.fn(async () => null),
    updateWorldModel: vi.fn(async () => null),
    archiveWorldModel: vi.fn(async () => null),
    unarchiveWorldModel: vi.fn(async () => null),
    listEpisodes: vi.fn(async () => []),
    listEpisodeRows: vi.fn(async () => []),
    countEpisodes: vi.fn(async () => 0),
    timeline: vi.fn(async () => []),
    listTraces: vi.fn(async () => []),
    countTraces: vi.fn(async () => 0),
    listApiLogs: vi.fn(async () => ({ logs: [], total: 0 })),
    listSkills: vi.fn(async () => []),
    countSkills: vi.fn(async () => 0),
    getSkill: vi.fn(async () => null),
    archiveSkill: vi.fn(async () => {}),
    deleteSkill: vi.fn(async () => ({ deleted: false })),
    reactivateSkill: vi.fn(async () => null),
    updateSkill: vi.fn(async () => null),
    shareSkill: vi.fn(async () => null),
    getConfig: vi.fn(async () => ({ version: 1 })),
    patchConfig: vi.fn(async () => ({ version: 1 })),
    metrics: vi.fn(async () => ({ total: 0, writesToday: 0, sessions: 0, embeddings: 0, dailyWrites: [] })),
    exportBundle: vi.fn(async () => ({ version: 1 as const, exportedAt: 0, traces: [], policies: [], worldModels: [], skills: [] })),
    importBundle: vi.fn(async () => ({ imported: 0, skipped: 0 })),
    embeddingMaintenanceStats: vi.fn(async () => ({
      dimension: 0,
      available: false,
      totalSlots: 0,
      ready: 0,
      missing: 0,
      dimMismatch: 0,
      needsRepair: 0,
      byKind: {
        trace: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
        policy: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
        world_model: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
        skill: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
      },
    })),
    rebuildEmbeddings: vi.fn(async () => ({
      mode: "repair",
      processed: 0,
      updated: 0,
      failed: 0,
      offset: 0,
      nextOffset: 0,
      done: true,
      statsBefore: {
        dimension: 0,
        available: false,
        totalSlots: 0,
        ready: 0,
        missing: 0,
        dimMismatch: 0,
        needsRepair: 0,
        byKind: {
          trace: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
          policy: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
          world_model: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
          skill: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
        },
      },
      statsAfter: {
        dimension: 0,
        available: false,
        totalSlots: 0,
        ready: 0,
        missing: 0,
        dimMismatch: 0,
        needsRepair: 0,
        byKind: {
          trace: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
          policy: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
          world_model: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
          skill: { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, needsRepair: 0 },
        },
      },
    })),
    subscribeEvents: vi.fn(() => () => {}),
    subscribeLogs: vi.fn(() => () => {}),
    forwardLog: vi.fn(),
  } as unknown as MemoryCore;
}

describe("compatibility routes", () => {
  it("registers and answers capability and matrix routes", async () => {
    const routes = new Routes();
    registerCompatibilityRoutes(routes, {
      core: stubCore(),
      home: { root: "/tmp" },
    });

    const caps = await routes.getExact("GET /api/v1/compatibility/capabilities")?.({
      req: {} as any,
      res: {} as any,
      url: new URL("http://localhost/api/v1/compatibility/capabilities"),
      body: Buffer.alloc(0),
      deps: { core: stubCore(), home: { root: "/tmp" } },
      params: {},
    });
    expect((caps as any).capabilities).toContain("session.start");
    expect((caps as any).capabilities).toContain("history.mine");

    const assess = await routes.getExact("POST /api/v1/compatibility/assess")?.({
      req: {} as any,
      res: {} as any,
      url: new URL("http://localhost/api/v1/compatibility/assess"),
      body: Buffer.from(JSON.stringify({
        agentKind: "private-agent",
        signals: { hasHistoryExport: true, canReadLogs: true },
      })),
      deps: { core: stubCore(), home: { root: "/tmp" } },
      params: {},
    });
    expect((assess as any).level).toBe("l0");
    expect((assess as any).mode).toBe("historical-connector");
    expect((assess as any).canMineHistory).toBe(true);

    const matrix = await routes.getExact("GET /api/v1/compatibility/matrix")?.({
      req: {} as any,
      res: {} as any,
      url: new URL("http://localhost/api/v1/compatibility/matrix?mode=mcp"),
      body: Buffer.alloc(0),
      deps: { core: stubCore(), home: { root: "/tmp" } },
      params: {},
    });
    expect((matrix as any).mode).toBe("mcp");
    expect((matrix as any).matrix["feedback.record"]).toBe("medium");
  });
});
