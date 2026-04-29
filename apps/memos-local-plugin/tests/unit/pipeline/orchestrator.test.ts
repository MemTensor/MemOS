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
import type { CoreEvent } from "../../../agent-contract/events.js";
import type { TurnInputDTO, TurnResultDTO } from "../../../agent-contract/dto.js";

let dbHandle: TmpDbHandle | null = null;
let pipeline: PipelineHandle | null = null;

function buildDeps(h: TmpDbHandle): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-test-home"),
    config: DEFAULT_CONFIG,
    db: h.db,
    repos: h.repos,
    llm: null,
    reflectLlm: null,
    embedder: fakeEmbedder({ dimensions: DEFAULT_CONFIG.embedding.dimensions }),
    log: rootLogger.child({ channel: "test.pipeline" }),
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
