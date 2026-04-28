/**
 * Hermes adapter — protocol-surface tests.
 *
 * The real Python client lives in `adapters/hermes/memos_provider/` and is
 * exercised by pytest. These TS tests verify that **the protocol surface
 * the Python adapter depends on** is present and behaves correctly when
 * invoked through `bridge/methods.ts`. Keeping them here means a refactor
 * of the JSON-RPC dispatcher can't silently break the Python client.
 *
 * Scope:
 *   - session.open / episode.open — used during `initialize()`.
 *   - turn.start — returns injected context for Python-side prefetch.
 *   - turn.end — accepts the completed turn payload.
 *   - memory.search / memory.get_* / memory.timeline — memory tools exposed to Hermes.
 *   - skill.list / skill.get — skill tools exposed to Hermes.
 *   - feedback.submit — thumbs-up/thumbs-down signal.
 *   - episode.close / session.close — shutdown path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeDispatcher } from "../../../bridge/methods.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubCore(): MemoryCore {
  return {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    health: vi.fn(async () => ({
      ok: true,
      version: "test",
      uptimeMs: 0,
      agent: "hermes",
      paths: { home: "", config: "", db: "", skills: "", logs: "" },
      llm: { available: false, provider: "mock" },
      embedder: { available: false, provider: "mock", dim: 0 },
    })),
    openSession: vi.fn(async ({ agent }) => `${agent}:session:1`),
    closeSession: vi.fn(async () => {}),
    openEpisode: vi.fn(async ({ sessionId }) => `${sessionId}:episode:1`),
    closeEpisode: vi.fn(async () => {}),
    onTurnStart: vi.fn(async ({ userText }) => ({
      tier1: [],
      tier2: [],
      tier3: [],
      injectedContext: `recalled: ${userText.slice(0, 20)}`,
      snippets: [],
    })),
    onTurnEnd: vi.fn(async () => ({ traceId: "t-1", episodeId: "e-1" })),
    submitFeedback: vi.fn(async (fb) => ({
      id: "fb-1",
      ts: Date.now(),
      ...fb,
    } as any)),
    recordToolOutcome: vi.fn(() => {}),
    searchMemory: vi.fn(async ({ query }) => ({
      tier1: [],
      tier2: [],
      tier3: [],
      injectedContext: "",
      snippets: [{ source: "tier2", text: `hit for ${query}`, score: 0.8 }],
      hits: [{ id: "t1", excerpt: `hit for ${query}`, score: 0.8 }],
    } as any)),
    getTrace: vi.fn(async (id) => ({ id, step: 0, ts: 0 }) as any),
    getPolicy: vi.fn(async () => null),
    getWorldModel: vi.fn(async () => null),
    listEpisodes: vi.fn(async () => []),
    timeline: vi.fn(async () => [{ id: "t1", step: 0, ts: 0 }] as any),
    listWorldModels: vi.fn(async () => [
      { id: "wm-1", title: "Hermes install", body: "path ~/.hermes/memos-plugin" },
    ] as any),
    listSkills: vi.fn(async () => [
      { id: "sk-1", name: "verify-hermes-memos", status: "active" },
    ] as any),
    getSkill: vi.fn(async (id) => ({ id, name: "verify-hermes-memos" }) as any),
    archiveSkill: vi.fn(async () => {}),
    subscribeEvents: vi.fn(() => () => {}),
    subscribeLogs: vi.fn(() => () => {}),
    forwardLog: vi.fn(() => {}),
  } as unknown as MemoryCore;
}

describe("hermes protocol surface", () => {
  it("initialize() path: session.open → episode.open", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);

    const sess = await dispatch("session.open", { agent: "hermes" });
    expect(core.openSession).toHaveBeenCalledWith({ agent: "hermes", sessionId: undefined });
    expect((sess as any).sessionId).toBe("hermes:session:1");

    const ep = await dispatch("episode.open", { sessionId: (sess as any).sessionId });
    expect((ep as any).episodeId).toBe("hermes:session:1:episode:1");
  });

  it("prefetch() path: turn.start returns injected context", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);

    const res = await dispatch("turn.start", {
      agent: "hermes",
      sessionId: "s-1",
      userText: "remind me about yesterday",
      ts: 123,
    });

    expect(res).toMatchObject({
      injectedContext: expect.stringContaining("recalled:"),
    });
    expect(core.onTurnStart).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "hermes", userText: "remind me about yesterday" }),
    );
  });

  it("sync_turn() path: turn.end accepts payload", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);

    await dispatch("turn.end", {
      agent: "hermes",
      sessionId: "s-1",
      episodeId: "e-1",
      agentText: "OK",
      toolCalls: [],
      ts: 456,
    });
    expect(core.onTurnEnd).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-1", episodeId: "e-1" }),
    );
  });

  it("memory_search tool: memory.search routes agent, session and topK to searchMemory", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);

    await dispatch("memory.search", {
      agent: "hermes",
      sessionId: "s-1",
      query: "yesterday",
      topK: { tier1: 5, tier2: 5, tier3: 5 },
    });
    expect(core.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "hermes",
        sessionId: "s-1",
        query: "yesterday",
        topK: { tier1: 5, tier2: 5, tier3: 5 },
      }),
    );
  });

  it("memory_timeline tool: memory.timeline routes to timeline", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);

    const res = await dispatch("memory.timeline", { episodeId: "e-1" });
    expect(core.timeline).toHaveBeenCalledWith({ episodeId: "e-1" });
    expect((res as any).traces).toBeInstanceOf(Array);
  });

  it("expanded Hermes tools route to memory and skill RPCs", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);

    await dispatch("memory.get_trace", { id: "t-1" });
    await dispatch("memory.get_policy", { id: "p-1" });
    await dispatch("memory.get_world", { id: "w-1" });
    const worlds = await dispatch("memory.list_world_models", {
      limit: 5,
      offset: 0,
      q: "Hermes",
    });
    const skills = await dispatch("skill.list", { status: "active", limit: 10 });
    const skill = await dispatch("skill.get", { id: "sk-1" });

    expect(core.getTrace).toHaveBeenCalledWith("t-1");
    expect(core.getPolicy).toHaveBeenCalledWith("p-1");
    expect(core.getWorldModel).toHaveBeenCalledWith("w-1");
    expect(core.listWorldModels).toHaveBeenCalledWith({ limit: 5, offset: 0, q: "Hermes" });
    expect((worlds as any).worldModels[0].id).toBe("wm-1");
    expect(core.listSkills).toHaveBeenCalledWith({ status: "active", limit: 10 });
    expect((skills as any).skills[0].id).toBe("sk-1");
    expect(core.getSkill).toHaveBeenCalledWith("sk-1");
    expect((skill as any).id).toBe("sk-1");
  });

  it("rejects malformed required ids before hitting core", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);

    await expect(dispatch("memory.get_trace", {})).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(dispatch("skill.get", { id: "" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(core.getTrace).not.toHaveBeenCalled();
    expect(core.getSkill).not.toHaveBeenCalled();
  });

  it("submit_feedback path: feedback.submit carries polarity+magnitude", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);

    await dispatch("feedback.submit", {
      channel: "explicit",
      polarity: "positive",
      magnitude: 0.7,
      rationale: "good reply",
    });
    expect(core.submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "explicit",
        polarity: "positive",
        magnitude: 0.7,
        rationale: "good reply",
      }),
    );
  });

  it("shutdown path: episode.close → session.close", async () => {
    const core = stubCore();
    const dispatch = makeDispatcher(core);

    await dispatch("episode.close", { episodeId: "e-1" });
    await dispatch("session.close", { sessionId: "s-1" });

    expect(core.closeEpisode).toHaveBeenCalledWith("e-1");
    expect(core.closeSession).toHaveBeenCalledWith("s-1");
  });
});
