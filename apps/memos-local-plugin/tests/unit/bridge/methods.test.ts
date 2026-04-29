/**
 * JSON-RPC dispatcher unit tests.
 *
 * We build a mock `MemoryCore` (not the real pipeline) so we can
 * assert method routing + param validation in isolation.
 */
import { describe, expect, it, vi } from "vitest";

import { makeDispatcher } from "../../../bridge/methods.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { MemosError } from "../../../agent-contract/errors.js";

function stubCore(overrides: Partial<MemoryCore> = {}): MemoryCore {
  const base: MemoryCore = {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    health: vi.fn(async () => ({
      ok: true,
      version: "t",
      uptimeMs: 1,
      agent: "openclaw",
      paths: { home: "", config: "", db: "", skills: "", logs: "" },
      llm: {
        available: false,
        provider: "",
        model: "",
        lastOkAt: null,
        lastError: null,
      },
      embedder: {
        available: false,
        provider: "",
        model: "",
        dim: 0,
        lastOkAt: null,
        lastError: null,
      },
      skillEvolver: {
        available: false,
        provider: "",
        model: "",
        inherited: true,
        lastOkAt: null,
        lastError: null,
      },
    })),
    openSession: vi.fn(async ({ sessionId }) => sessionId ?? "s-auto"),
    closeSession: vi.fn(async () => {}),
    openEpisode: vi.fn(async ({ episodeId }) => episodeId ?? "e-auto"),
    closeEpisode: vi.fn(async () => {}),
    deleteEpisode: vi.fn(async () => ({ deleted: true })),
    deleteEpisodes: vi.fn(async () => ({ deleted: 1 })),
    onTurnStart: vi.fn(async () => ({
      query: { agent: "openclaw", query: "" },
      hits: [],
      injectedContext: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    })),
    onTurnEnd: vi.fn(async () => ({ traceId: "tr-1", episodeId: "e-1" })),
    submitFeedback: vi.fn(async (fb) => ({
      id: "fb-1",
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
    searchMemory: vi.fn(async (q) => ({
      query: q,
      hits: [{ tier: 1 as const, refId: "a", refKind: "skill" as const, score: 0.9, snippet: "s" }],
      injectedContext: "s",
      tierLatencyMs: { tier1: 1, tier2: 1, tier3: 1 },
    })),
    getTrace: vi.fn(async () => null),
    updateTrace: vi.fn(async () => null),
    deleteTrace: vi.fn(async () => ({ deleted: true })),
    deleteTraces: vi.fn(async () => ({ deleted: 0 })),
    shareTrace: vi.fn(async () => null),
    getPolicy: vi.fn(async () => null),
    listPolicies: vi.fn(async () => []),
    setPolicyStatus: vi.fn(async () => null),
    deletePolicy: vi.fn(async () => ({ deleted: false })),
    editPolicyGuidance: vi.fn(async () => null),
    sharePolicy: vi.fn(async () => null),
    updatePolicy: vi.fn(async () => null),
    getWorldModel: vi.fn(async () => null),
    listWorldModels: vi.fn(async () => []),
    deleteWorldModel: vi.fn(async () => ({ deleted: false })),
    shareWorldModel: vi.fn(async () => null),
    updateWorldModel: vi.fn(async () => null),
    archiveWorldModel: vi.fn(async () => null),
    unarchiveWorldModel: vi.fn(async () => null),
    listEpisodes: vi.fn(async () => ["e-1", "e-2"]),
    listEpisodeRows: vi.fn(async () => []),
    timeline: vi.fn(async () => []),
    listTraces: vi.fn(async () => []),
    listApiLogs: vi.fn(async () => ({ logs: [], total: 0 })),
    listSkills: vi.fn(async () => []),
    getSkill: vi.fn(async () => null),
    archiveSkill: vi.fn(async () => {}),
    deleteSkill: vi.fn(async () => ({ deleted: false })),
    reactivateSkill: vi.fn(async () => null),
    updateSkill: vi.fn(async () => null),
    shareSkill: vi.fn(async () => null),
    getConfig: vi.fn(async () => ({})),
    patchConfig: vi.fn(async () => ({})),
    metrics: vi.fn(async () => ({
      total: 0,
      writesToday: 0,
      sessions: 0,
      embeddings: 0,
      dailyWrites: [],
      skillStats: {
        total: 0,
        active: 0,
        candidate: 0,
        archived: 0,
        evolutionRate: 0,
      },
      policyStats: {
        total: 0,
        active: 0,
        candidate: 0,
        archived: 0,
        avgGain: 0,
        avgQuality: 0,
      },
      worldModelCount: 0,
      decisionRepairCount: 0,
      dailySkillEvolutions: [],
      recentEvolutions: [],
    })),
    exportBundle: vi.fn(async () => ({
      version: 1 as const,
      exportedAt: 0,
      traces: [],
      policies: [],
      worldModels: [],
      skills: [],
    })),
    importBundle: vi.fn(async () => ({ imported: 0, skipped: 0 })),
    subscribeEvents: vi.fn(() => () => {}),
    getRecentEvents: vi.fn(() => []),
    subscribeLogs: vi.fn(() => () => {}),
    forwardLog: vi.fn(),
    ...overrides,
  };
  return base;
}

describe("makeDispatcher", () => {
  it("routes lifecycle methods", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);
    await expect(dispatch("core.init", {})).resolves.toEqual({ ok: true });
    await expect(dispatch("core.health", {})).resolves.toMatchObject({ ok: true });
    await expect(dispatch("core.shutdown", {})).resolves.toEqual({ ok: true });
    expect(core.init).toHaveBeenCalled();
    expect(core.shutdown).toHaveBeenCalled();
  });

  it("routes session + episode methods with id passthrough", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);
    const s = await dispatch("session.open", {
      agent: "openclaw",
      sessionId: "s-123",
    });
    expect(s).toEqual({ sessionId: "s-123" });
    await expect(dispatch("session.close", { sessionId: "s-123" })).resolves.toEqual({ ok: true });
    await expect(dispatch("episode.open", { sessionId: "s-123" })).resolves.toMatchObject({
      episodeId: expect.any(String),
    });
    await expect(dispatch("episode.close", { episodeId: "e-1" })).resolves.toEqual({ ok: true });
  });

  it("routes memory.search + memory.get_trace + memory.timeline", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);
    const res = await dispatch("memory.search", {
      agent: "openclaw",
      query: "where is config?",
    });
    expect(res).toMatchObject({ hits: [expect.objectContaining({ refKind: "skill" })] });
    await dispatch("memory.get_trace", { id: "tr-1" });
    expect(core.getTrace).toHaveBeenCalledWith("tr-1");
    await dispatch("memory.timeline", { episodeId: "e-1" });
    expect(core.timeline).toHaveBeenCalledWith({ episodeId: "e-1" });
  });

  it("validates required params and raises invalid_argument", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);
    await expect(dispatch("memory.search", { agent: "openclaw" } as any)).rejects.toSatisfy(
      (err) => err instanceof MemosError && err.code === "invalid_argument",
    );
    await expect(dispatch("session.open", null as any)).rejects.toSatisfy(
      (err) => err instanceof MemosError && err.code === "invalid_argument",
    );
    await expect(dispatch("session.close", {} as any)).rejects.toSatisfy(
      (err) => err instanceof MemosError && err.code === "invalid_argument",
    );
  });

  it("raises unknown_method for unregistered names", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);
    await expect(dispatch("bogus.method", {})).rejects.toSatisfy(
      (err) => err instanceof MemosError && err.code === "unknown_method",
    );
  });

  it("raises protocol_error for transport-only methods", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);
    await expect(dispatch("logs.tail", {})).rejects.toSatisfy(
      (err) => err instanceof MemosError && err.code === "protocol_error",
    );
    await expect(dispatch("events.subscribe", {})).rejects.toSatisfy(
      (err) => err instanceof MemosError && err.code === "protocol_error",
    );
  });

  it("strict mode fails fast on malformed turn.start", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core, { strict: true });
    await expect(
      dispatch("turn.start", {
        agent: "openclaw",
        sessionId: "s-1",
        userText: "hi",
        // missing ts
      }),
    ).rejects.toSatisfy(
      (err) => err instanceof MemosError && err.code === "invalid_argument",
    );
  });

  it("feedback.submit forwards the DTO shape intact", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);
    const out = (await dispatch("feedback.submit", {
      channel: "explicit",
      polarity: "positive",
      magnitude: 0.7,
      rationale: "helpful",
      traceId: "tr-1",
    })) as Record<string, unknown>;
    expect(out.polarity).toBe("positive");
    expect(core.submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "explicit",
        polarity: "positive",
        magnitude: 0.7,
        rationale: "helpful",
        traceId: "tr-1",
      }),
    );
  });
});
