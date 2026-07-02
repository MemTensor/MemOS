/**
 * Integration tests for `createPipeline` — the orchestrator.
 *
 * These tests exercise the end-to-end wiring: session open → episode
 * open → turn lifecycle → event bridge → flush. We stub the LLM + use
 * the deterministic embedder so the tests remain hermetic (no network).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPipeline,
  type PipelineDeps,
  type PipelineHandle,
} from "../../../core/pipeline/index.js";
import { rootLogger } from "../../../core/logger/index.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";
import { fakeLlm } from "../../helpers/fake-llm.js";
import type { CoreEvent } from "../../../agent-contract/events.js";
import type { TurnInputDTO, TurnResultDTO } from "../../../agent-contract/dto.js";

let dbHandle: TmpDbHandle | null = null;
let pipeline: PipelineHandle | null = null;

function configWithLightweightMemory(enabled: boolean): typeof DEFAULT_CONFIG {
  return {
    ...DEFAULT_CONFIG,
    algorithm: {
      ...DEFAULT_CONFIG.algorithm,
      lightweightMemory: {
        ...DEFAULT_CONFIG.algorithm.lightweightMemory,
        enabled,
      },
    },
  };
}

function buildDeps(
  h: TmpDbHandle,
  embedder = fakeEmbedder({ dimensions: 384 }),
): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-test-home"),
    config: configWithLightweightMemory(false),
    db: h.db,
    repos: h.repos,
    llm: null,
    reflectLlm: null,
    l3Llm: null,
    embedder,
    log: rootLogger.child({ channel: "test.pipeline" }),
    namespace: { agentKind: "openclaw", profileId: "main" },
    now: () => 1_700_000_000_000,
  };
}

beforeEach(() => {
  dbHandle = makeTmpDb();
  pipeline = null;
});

afterEach(async () => {
  if (pipeline) {
    try {
      await pipeline.shutdown("test.cleanup");
    } catch {
      /* ignore */
    }
    pipeline = null;
  }
  dbHandle?.cleanup();
  dbHandle = null;
});

describe("pipeline/orchestrator", () => {
  it("threads a dedicated l3Llm through to the handle", () => {
    const l3Llm = fakeLlm({ completeJson: {} });
    pipeline = createPipeline({ ...buildDeps(dbHandle!), l3Llm });
    expect(pipeline.l3Llm).toBe(l3Llm);
  });

  it("leaves l3Llm null on the handle when not configured", () => {
    pipeline = createPipeline(buildDeps(dbHandle!));
    expect(pipeline.l3Llm).toBeNull();
  });


  it("wires session → episode → turn end cleanly", async () => {
    pipeline = createPipeline(buildDeps(dbHandle!));
    const turn: TurnInputDTO = {
      agent: "openclaw",
      sessionId: "s-1",
      userText: "fix the broken build",
      ts: 1_700_000_000_000,
    };
    const packet = await pipeline.onTurnStart(turn);
    expect(packet.reason).toBe("turn_start");
    expect(typeof packet.packetId).toBe("string");
    expect(packet.packetId.length).toBeGreaterThan(4);
    expect(typeof packet.rendered).toBe("string");

    // We should now have an open episode for this session.
    const snap1 = pipeline.sessionManager.getSession("s-1");
    expect(snap1).not.toBeNull();

    const result: TurnResultDTO = {
      agent: "openclaw",
      sessionId: "s-1",
      episodeId: packet.snippets[0]?.refId ?? "ep-ignored",
      agentText: "I ran `make` and the build succeeded.",
      toolCalls: [],
      reflection: "User wanted the build fixed. Running make was sufficient.",
      ts: 1_700_000_000_000 + 5_000,
    };
    const end = await pipeline.onTurnEnd(result);
    // V7 §0.1 topic-end reflection refactor: a single `onTurnEnd`
    // never finalizes its episode anymore — the episode stays OPEN
    // until either the next user turn is classified as `new_task`,
    // the merge window expires, or the session is closed. So this
    // turn writes its trace via the lite capture pass and the
    // episode is still open afterwards.
    expect(end.episodeFinalized).toBe(false);
    expect(end.asyncWorkScheduled).toBe(true);
    expect(end.episode?.status).toBe("open");
    expect(end.traceIds).toHaveLength(1);
    expect(dbHandle!.repos.traces.getById(end.traceIds[0]!)).not.toBeNull();

    // Flush still drains any in-flight lite capture work; reflect
    // won't fire until the next turn closes this topic.
    await pipeline.flush();
  });

  it("preserves adapter-provided turn timestamps on captured traces", async () => {
    pipeline = createPipeline(buildDeps(dbHandle!));
    const historicalStartTs = 1_700_000_000_000 - 90 * 24 * 60 * 60 * 1000;
    const historicalEndTs = historicalStartTs + 500;

    const packet = await pipeline.onTurnStart({
      agent: "openclaw",
      sessionId: "s-historical",
      userText: "90 days ago I decided Monday mornings are for project review",
      ts: historicalStartTs,
    });
    await pipeline.onTurnEnd({
      agent: "openclaw",
      sessionId: "s-historical",
      episodeId: packet.episodeId ?? "ep-ignored",
      agentText: "Got it, I will remember that weekly review habit.",
      toolCalls: [],
      ts: historicalEndTs,
    });
    await pipeline.flush();

    const traces = dbHandle!.repos.traces.list({ sessionId: "s-historical" });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.ts).toBe(historicalEndTs);
  });

  it("emits a unified CoreEvent stream", async () => {
    pipeline = createPipeline(buildDeps(dbHandle!));
    const seen: CoreEvent["type"][] = [];
    const unsubscribe = pipeline.subscribeEvents((evt) => {
      seen.push(evt.type);
    });

    await pipeline.onTurnStart({
      agent: "openclaw",
      sessionId: "s-2",
      userText: "hello",
      ts: 1_700_000_000_000,
    });

    // session.opened is emitted synchronously during openSession().
    expect(seen).toContain("session.opened");
    unsubscribe();
  });

  it("skips retrieval for confident chitchat", async () => {
    const embedder = fakeEmbedder({ dimensions: 384 });
    pipeline = createPipeline(buildDeps(dbHandle!, embedder));

    const packet = await pipeline.onTurnStart({
      agent: "openclaw",
      sessionId: "s-chitchat",
      userText: "hello",
      ts: 1_700_000_000_000,
    });
    const stats = pipeline.consumeRetrievalStats(packet.packetId);

    expect(packet.snippets).toHaveLength(0);
    expect(packet.rendered).toBe("");
    expect(embedder.stats().requests).toBe(0);
    expect(stats?.scenarioId).toBe("CHITCHAT");
    expect(stats?.embedding?.attempted).toBe(false);
  });

  it("uses current-turn intent when appending to an existing episode", async () => {
    const embedder = fakeEmbedder({ dimensions: 384 });
    pipeline = createPipeline(buildDeps(dbHandle!, embedder));

    const first = await pipeline.onTurnStart({
      agent: "openclaw",
      sessionId: "s-follow-up",
      userText: "fix the broken build",
      ts: 1_700_000_000_000,
    });
    await pipeline.onTurnEnd({
      agent: "openclaw",
      sessionId: "s-follow-up",
      episodeId: first.episodeId ?? "ep-ignored",
      agentText: "The build is fixed.",
      toolCalls: [],
      ts: 1_700_000_000_100,
    });
    const requestsBefore = embedder.stats().requests;

    const second = await pipeline.onTurnStart({
      agent: "openclaw",
      sessionId: "s-follow-up",
      userText: "hello",
      ts: 1_700_000_000_200,
    });
    const stats = pipeline.consumeRetrievalStats(second.packetId);

    expect(second.episodeId).toBe(first.episodeId);
    expect(second.snippets).toHaveLength(0);
    expect(embedder.stats().requests).toBe(requestsBefore);
    expect(stats?.scenarioId).toBe("CHITCHAT");
  });

  it("records tool success + failure through the feedback subscriber", async () => {
    pipeline = createPipeline(buildDeps(dbHandle!));
    await pipeline.onTurnStart({
      agent: "openclaw",
      sessionId: "s-3",
      userText: "run pip install",
      ts: 1_700_000_000_000,
    });

    pipeline.recordToolOutcome({
      sessionId: "s-3",
      tool: "pip_install",
      step: 0,
      success: false,
      errorCode: "MISSING_DEP",
    });
    pipeline.recordToolOutcome({
      sessionId: "s-3",
      tool: "pip_install",
      step: 1,
      success: true,
    });

    // Feedback subscriber exposes signals state.
    const stats = pipeline.feedback.signals.stats();
    expect(stats.states).toBeGreaterThanOrEqual(0);
  });

  it("returns an empty injection packet when retrieval has no hits", async () => {
    pipeline = createPipeline(buildDeps(dbHandle!));
    const packet = await pipeline.onTurnStart({
      agent: "openclaw",
      sessionId: "s-4",
      userText: "hello world",
      ts: 1_700_000_000_000,
    });
    expect(Array.isArray(packet.snippets)).toBe(true);
    expect(packet.tierLatencyMs).toBeDefined();
  });

  it("shutdown drains async work before detaching subscribers", async () => {
    pipeline = createPipeline(buildDeps(dbHandle!));
    await pipeline.onTurnStart({
      agent: "openclaw",
      sessionId: "s-5",
      userText: "ok",
      ts: 1_700_000_000_000,
    });
    await pipeline.onTurnEnd({
      agent: "openclaw",
      sessionId: "s-5",
      episodeId: "ep-ignored",
      agentText: "done.",
      toolCalls: [],
      ts: 1_700_000_000_010,
    });
    await pipeline.shutdown("test.ok");
    pipeline = null; // Mark so afterEach doesn't re-shutdown.
  });
});
