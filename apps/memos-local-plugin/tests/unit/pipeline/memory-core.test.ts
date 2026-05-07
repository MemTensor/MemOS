/**
 * MemoryCore façade tests.
 *
 * We drive the façade through its public interface (the shape adapters
 * see). The pipeline is wrapped directly via `createMemoryCore` with a
 * hand-built `PipelineHandle` so we control clocks + providers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMemoryCore,
  createPipeline,
  bootstrapMemoryCore,
  type PipelineDeps,
  type PipelineHandle,
} from "../../../core/pipeline/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import type { TraceDTO } from "../../../agent-contract/dto.js";
import { rootLogger } from "../../../core/logger/index.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { makeTmpHome, type TmpHomeContext } from "../../helpers/tmp-home.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";
import type { MemosError } from "../../../agent-contract/errors.js";

let db: TmpDbHandle | null = null;
let pipeline: PipelineHandle | null = null;
let core: MemoryCore | null = null;

function buildDeps(h: TmpDbHandle): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-mc-test"),
    config: DEFAULT_CONFIG,
    db: h.db,
    repos: h.repos,
    llm: null,
    reflectLlm: null,
    embedder: fakeEmbedder({ dimensions: DEFAULT_CONFIG.embedding.dimensions }),
    log: rootLogger.child({ channel: "test.memory-core" }),
    namespace: { agentKind: "openclaw", profileId: "main" },
    now: () => 1_700_000_000_000,
  };
}

function traceKind(trace: TraceDTO): string {
  return trace.toolCalls[0]?.name ??
    (trace.agentText.includes("Subagent task:")
      ? "subagent_task_text"
      : trace.agentText.includes("Subagent result:")
      ? "subagent_result_text"
      : "assistant");
}

beforeEach(() => {
  db = makeTmpDb();
});

afterEach(async () => {
  if (core) {
    try {
      await core.shutdown();
    } catch {
      /* ignore */
    }
    core = null;
    pipeline = null; // Pipeline is shut down by core.
  } else if (pipeline) {
    try {
      await pipeline.shutdown("test.cleanup");
    } catch {
      /* ignore */
    }
    pipeline = null;
  }
  db?.cleanup();
  db = null;
});

describe("MemoryCore façade", () => {
  it("init + health + shutdown lifecycle", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test-1.0.0",
    );
    await core.init();
    const h = await core.health();
    expect(h.ok).toBe(true);
    expect(h.version).toBe("test-1.0.0");
    expect(h.agent).toBe("openclaw");
    expect(h.paths.db.endsWith(".db") || h.paths.db.length > 0).toBe(true);
    expect(h.embedder.available).toBe(true);
    expect(h.embedder.dim).toBe(DEFAULT_CONFIG.embedding.dimensions);
    expect(h.llm.available).toBe(false);
  });

  it("openSession + closeSession roundtrip", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const sid = await core.openSession({ agent: "openclaw" });
    expect(sid).toBeTruthy();
    await core.closeSession(sid);
  });

  it("onTurnStart returns a RetrievalResultDTO with tier latencies", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const res = await core.onTurnStart({
      agent: "openclaw",
      sessionId: "s-x",
      userText: "how do I build this project?",
      ts: 1_700_000_000_000,
    });
    expect(res.tierLatencyMs).toBeDefined();
    expect(typeof res.injectedContext).toBe("string");
    expect(res.query.query).toBe("how do I build this project?");
  });

  it("isolates private traces by namespace and exposes local shared traces", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    const mainNs = { agentKind: "openclaw", profileId: "main" };
    const reviewerNs = { agentKind: "openclaw", profileId: "reviewer" };

    const start = await core.onTurnStart({
      agent: "openclaw",
      namespace: mainNs,
      sessionId: "s-main",
      userText: "remember namespace private trace",
      ts: 1_700_000_000_001,
    });
    await core.onTurnEnd({
      agent: "openclaw",
      namespace: mainNs,
      sessionId: "s-main",
      episodeId: start.query.episodeId!,
      agentText: "stored only for main",
      toolCalls: [],
      ts: 1_700_000_000_002,
    });

    const ownerRows = await core.listTraces({ limit: 10 });
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0]?.ownerProfileId).toBe("main");

    await core.openSession({ agent: "openclaw", sessionId: "s-reviewer", namespace: reviewerNs });
    expect(await core.listTraces({ limit: 10 })).toHaveLength(0);

    await core.openSession({ agent: "openclaw", sessionId: "s-main", namespace: mainNs });
    await core.shareTrace(ownerRows[0]!.id, { scope: "local" });

    await core.openSession({ agent: "openclaw", sessionId: "s-reviewer", namespace: reviewerNs });
    const sharedRows = await core.listTraces({ limit: 10 });
    expect(sharedRows).toHaveLength(1);
    expect(sharedRows[0]?.share?.scope).toBe("local");
  });

  it("records visible subagent task and result in the parent episode", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const turn = await core.onTurnStart({
      agent: "hermes",
      sessionId: "s-parent",
      userText: "delegate package script inspection",
      ts: 1_700_000_000_000,
    });
    const episodeId = turn.query.episodeId!;

    await core.recordSubagentOutcome({
      agent: "hermes",
      sessionId: "s-parent",
      episodeId,
      childSessionId: "s-child",
      task: "check package.json scripts",
      result: "found build and test scripts",
      toolCalls: [
        {
          name: "read_file",
          input: { path: "package.json", limit: 20 },
          output: "{\"scripts\":{\"build\":\"tsc\"}}",
          startedAt: 1_700_000_000_001,
          endedAt: 1_700_000_000_002,
        },
      ],
      outcome: "ok",
      ts: 1_700_000_000_001,
    });

    const timeline = await core.timeline({ episodeId });
    const subagentTrace = timeline.find((trace) =>
      trace.agentText.includes("Subagent task:"),
    );
    const toolTrace = timeline.find((trace) =>
      trace.toolCalls.some((call) => call.name === "subagent"),
    );

    expect(subagentTrace?.agentText).toContain(
      "Subagent task: check package.json scripts",
    );
    expect(subagentTrace?.agentText).toContain(
      "Subagent result: found build and test scripts",
    );
    expect(toolTrace?.toolCalls[0]?.input).toMatchObject({
      task: "check package.json scripts",
      childSessionId: "s-child",
      outcome: "ok",
    });

    const childEpisodes = await core.listEpisodeRows({
      sessionId: "s-child",
      limit: 10,
    });
    expect(childEpisodes).toHaveLength(1);
    const childTimeline = await core.timeline({ episodeId: childEpisodes[0]!.id });
    expect(childTimeline.some((trace) =>
      trace.userText.includes("Subagent task: check package.json scripts")
    )).toBe(true);
    expect(childTimeline.some((trace) =>
      trace.agentText.includes("Subagent result: found build and test scripts")
    )).toBe(true);
    expect(childTimeline.some((trace) =>
      trace.toolCalls.some((call) => call.name === "read_file")
    )).toBe(true);
  });

  it("anchors subagent records after the matching delegate_task tool call id", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const turn = await core.onTurnStart({
      agent: "hermes",
      sessionId: "s-parent",
      userText: "delegate weather lookup",
      ts: 1_700_000_000_000,
    });
    const episodeId = turn.query.episodeId!;
    const delegateGoal = "check Hangzhou weather";
    await core.onTurnEnd({
      agent: "hermes",
      sessionId: "s-parent",
      episodeId,
      agentText: "I will use the delegated result.",
      toolCalls: [
        {
          name: "delegate_task",
          toolCallId: "call_delegate_1",
          input: { goal: delegateGoal, context: "weather" },
          output: { results: [{ task_index: 0, summary: "sunny" }] },
          startedAt: 1_700_000_000_100,
          endedAt: 1_700_000_000_200,
        },
      ],
      ts: 1_700_000_000_300,
    });

    await core.recordSubagentOutcome({
      agent: "hermes",
      sessionId: "s-parent",
      episodeId,
      childSessionId: "s-child",
      task: delegateGoal,
      result: "sunny",
      outcome: "ok",
      ts: 1_700_000_000_050,
      meta: { hookKwargs: { tool_call_id: "call_delegate_1" } },
    });

    const timeline = await core.timeline({ episodeId });
    const order = timeline.map((trace) =>
      trace.toolCalls[0]?.name ??
        (trace.agentText.includes("Subagent task:")
          ? "subagent_task_text"
          : trace.agentText.includes("Subagent result:")
          ? "subagent_result_text"
          : "assistant"),
    );
    expect(order).toEqual([
      "delegate_task",
      "subagent",
      "subagent_task_text",
      "assistant",
    ]);
    const rows = await core.listEpisodeRows({ sessionId: "s-parent", limit: 10 });
    expect(rows.find((row) => row.id === episodeId)?.turnCount).toBe(1);
  });

  it("anchors subagent records by a unique matching delegate goal when tool call id is absent", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const turn = await core.onTurnStart({
      agent: "hermes",
      sessionId: "s-parent",
      userText: "delegate Canada weather",
      ts: 1_700_000_000_000,
    });
    const episodeId = turn.query.episodeId!;
    const delegateGoal = "check Canada weather";

    await core.recordSubagentOutcome({
      agent: "hermes",
      sessionId: "s-parent",
      episodeId,
      childSessionId: "s-child",
      task: delegateGoal,
      result: "Toronto sunny",
      outcome: "ok",
      ts: 1_700_000_000_050,
      meta: { hookKwargs: {} },
    });
    await core.onTurnEnd({
      agent: "hermes",
      sessionId: "s-parent",
      episodeId,
      agentText: "Here is the delegated result.",
      toolCalls: [
        {
          name: "delegate_task",
          toolCallId: "call_delegate_late",
          input: { goal: delegateGoal, context: "weather" },
          output: "Toronto sunny",
          startedAt: 1_700_000_000_100,
          endedAt: 1_700_000_000_200,
        },
      ],
      ts: 1_700_000_000_300,
    });

    const timeline = await core.timeline({ episodeId });
    expect(timeline.map(traceKind)).toEqual([
      "delegate_task",
      "subagent",
      "subagent_task_text",
      "assistant",
    ]);
    const delegateTrace = timeline.find((trace) => trace.toolCalls[0]?.name === "delegate_task")!;
    const subagentTrace = timeline.find((trace) => trace.toolCalls[0]?.name === "subagent")!;
    expect(delegateTrace.userText).toBe("delegate Canada weather");
    expect(subagentTrace.userText).toBe("");
  });

  it("does not anchor by goal when multiple delegate_task traces share the same goal", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const turn = await core.onTurnStart({
      agent: "hermes",
      sessionId: "s-parent",
      userText: "delegate duplicate weather tasks",
      ts: 1_700_000_000_000,
    });
    const episodeId = turn.query.episodeId!;
    const delegateGoal = "check Canada weather";

    await core.recordSubagentOutcome({
      agent: "hermes",
      sessionId: "s-parent",
      episodeId,
      childSessionId: "s-child",
      task: delegateGoal,
      result: "Toronto sunny",
      outcome: "ok",
      ts: 1_700_000_000_050,
      meta: { hookKwargs: {} },
    });
    await core.onTurnEnd({
      agent: "hermes",
      sessionId: "s-parent",
      episodeId,
      agentText: "Here is the delegated result.",
      toolCalls: [
        {
          name: "delegate_task",
          toolCallId: "call_delegate_1",
          input: { goal: delegateGoal, city: "Toronto" },
          output: "Toronto sunny",
          startedAt: 1_700_000_000_100,
          endedAt: 1_700_000_000_200,
        },
        {
          name: "delegate_task",
          toolCallId: "call_delegate_2",
          input: { goal: delegateGoal, city: "Vancouver" },
          output: "Vancouver rainy",
          startedAt: 1_700_000_000_210,
          endedAt: 1_700_000_000_250,
        },
      ],
      ts: 1_700_000_000_300,
    });

    const timeline = await core.timeline({ episodeId });
    expect(timeline.map(traceKind).slice(0, 3)).toEqual([
      "subagent",
      "subagent_task_text",
      "delegate_task",
    ]);
  });

  it("submitFeedback persists and returns a DTO", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const fb = await core.submitFeedback({
      channel: "explicit",
      polarity: "negative",
      magnitude: 0.8,
      rationale: "broken",
    });
    expect(fb.id).toBeTruthy();
    expect(fb.polarity).toBe("negative");
    expect(fb.magnitude).toBe(0.8);

    // Verify it's actually in the repo.
    expect(db!.repos.feedback.getById(fb.id)).not.toBeNull();
  });

  it("onTurnEnd returns a real persisted trace id that feedback accepts", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    const start = await core.onTurnStart({
      agent: "openclaw",
      sessionId: "s-feedback",
      userText: "remember that I prefer short status updates",
      ts: 1_700_000_000_000,
    });
    const end = await core.onTurnEnd({
      agent: "openclaw",
      sessionId: start.query.sessionId!,
      episodeId: start.query.episodeId!,
      agentText: "Got it.",
      toolCalls: [],
      ts: 1_700_000_000_500,
    });

    expect(end.traceId).toMatch(/^tr_/);
    expect(db!.repos.traces.getById(end.traceId as never)).not.toBeNull();

    const fb = await core.submitFeedback({
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      traceId: end.traceId,
      episodeId: end.episodeId,
    });
    expect(fb.traceId).toBe(end.traceId);
    const scored = db!.repos.traces.getById(end.traceId as never)!;
    expect(scored.value).toBe(1);
    expect(scored.rHuman).toBe(1);
    expect(scored.priority).toBe(1);
  });

  it("onTurnEnd preserves adapter-provided historical timestamps", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    const oldUserTs = 1_692_224_000_000;
    const oldAssistantTs = oldUserTs + 1_500;
    const start = await core.onTurnStart({
      agent: "openclaw",
      sessionId: "s-historical-ts",
      userText: "remember this imported historical preference",
      ts: oldUserTs,
    });
    const end = await core.onTurnEnd({
      agent: "openclaw",
      sessionId: start.query.sessionId!,
      episodeId: start.query.episodeId!,
      agentText: "I will keep that historical preference.",
      toolCalls: [],
      ts: oldAssistantTs,
    });

    const trace = db!.repos.traces.getById(end.traceId as never)!;
    expect(trace.ts).toBe(oldAssistantTs);
    expect(trace.turnId).toBe(oldUserTs);
    expect(trace.ts).toBeLessThan(Date.now() - 30 * 24 * 60 * 60 * 1000);
  });

  it("submitFeedback aggregates explicit trace feedback into trace value", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    const start = await core.onTurnStart({
      agent: "openclaw",
      sessionId: "s-feedback-aggregate",
      userText: "remember that compact release reports are useful",
      ts: 1_700_000_100_000,
    });
    const end = await core.onTurnEnd({
      agent: "openclaw",
      sessionId: start.query.sessionId!,
      episodeId: start.query.episodeId!,
      agentText: "I will keep release reports compact.",
      toolCalls: [],
      ts: 1_700_000_100_500,
    });

    await core.submitFeedback({
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      traceId: end.traceId,
      episodeId: end.episodeId,
    });
    expect(db!.repos.traces.getById(end.traceId as never)!.value).toBe(1);

    await core.submitFeedback({
      channel: "explicit",
      polarity: "negative",
      magnitude: 0.5,
      traceId: end.traceId,
      episodeId: end.episodeId,
    });
    const scored = db!.repos.traces.getById(end.traceId as never)!;
    expect(scored.value).toBeCloseTo(1 / 3);
    expect(scored.rHuman).toBeCloseTo(1 / 3);
    expect(scored.priority).toBe(1);
  });

  it("submitFeedback rejects unknown trace ids before SQLite FK failure", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    await expect(core.submitFeedback({
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      traceId: "trace-not-in-db",
    })).rejects.toMatchObject({
      name: "MemosError",
      code: "trace_not_found",
    } satisfies Partial<MemosError>);
  });

  it("listEpisodes + timeline return empty arrays when nothing has happened", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const eps = await core.listEpisodes({ limit: 10 });
    expect(eps.length).toBe(0);
    const tl = await core.timeline({ episodeId: "ep-missing" });
    expect(tl.length).toBe(0);
  });

  it("timeline preserves episode trace order instead of timestamp order", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    db!.repos.sessions.upsert({
      id: "s-order",
      agent: "openclaw",
      startedAt: 1_000,
      lastSeenAt: 2_000,
      meta: {},
    });
    db!.repos.episodes.insert({
      id: "ep-order",
      sessionId: "s-order",
      startedAt: 1_000,
      endedAt: 2_000,
      traceIds: ["tr-late", "tr-early"] as never,
      rTask: null,
      status: "closed",
      meta: {},
    });
    const baseTrace = {
      episodeId: "ep-order",
      sessionId: "s-order",
      userText: "",
      agentText: "",
      summary: null,
      reflection: null,
      agentThinking: null,
      value: 0,
      alpha: 0,
      rHuman: null,
      priority: 0,
      tags: [],
      errorSignatures: [],
      vecSummary: null,
      vecAction: null,
      turnId: 1_000,
      schemaVersion: 1,
    } as const;
    db!.repos.traces.insert({
      ...baseTrace,
      id: "tr-early",
      ts: 1_100,
      toolCalls: [{ name: "terminal", input: "", startedAt: 1_000, endedAt: 1_100 }],
    } as never);
    db!.repos.traces.insert({
      ...baseTrace,
      id: "tr-late",
      ts: 1_500,
      userText: "first in conversation",
      toolCalls: [{ name: "todo", input: "" }],
    } as never);

    await core.init();
    const tl = await core.timeline({ episodeId: "ep-order" });

    expect(tl.map((tr) => tr.id)).toEqual(["tr-late", "tr-early"]);
    const grouped = await core.listTraces({ groupByTurn: true });
    expect(grouped.map((tr) => tr.id)).toEqual(["tr-late", "tr-early"]);
  });

  it("deleteTrace removes FTS entries and episode trace references", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    db!.repos.sessions.upsert({
      id: "s-delete",
      agent: "openclaw",
      ownerAgentKind: "openclaw",
      ownerProfileId: "main",
      ownerWorkspaceId: null,
      startedAt: 1_000,
      lastSeenAt: 2_000,
      meta: {},
    });
    db!.repos.episodes.insert({
      id: "ep-delete",
      sessionId: "s-delete",
      ownerAgentKind: "openclaw",
      ownerProfileId: "main",
      ownerWorkspaceId: null,
      startedAt: 1_000,
      endedAt: 2_000,
      traceIds: ["tr-keep", "tr-delete"] as never,
      rTask: null,
      status: "closed",
      meta: {},
    });
    const baseTrace = {
      episodeId: "ep-delete",
      sessionId: "s-delete",
      ownerAgentKind: "openclaw",
      ownerProfileId: "main",
      ownerWorkspaceId: null,
      agentText: "",
      summary: null,
      toolCalls: [],
      reflection: null,
      agentThinking: null,
      value: 0,
      alpha: 0,
      rHuman: null,
      priority: 0,
      tags: [],
      errorSignatures: [],
      vecSummary: null,
      vecAction: null,
      turnId: 1_000,
      schemaVersion: 1,
    } as const;
    db!.repos.traces.insert({
      ...baseTrace,
      id: "tr-keep",
      ts: 1_100,
      userText: "keep marker",
    } as never);
    db!.repos.traces.insert({
      ...baseTrace,
      id: "tr-delete",
      ts: 1_200,
      userText: "sensitive-delete-marker",
    } as never);

    await core.init();
    expect(await core.deleteTrace("tr-delete")).toEqual({ deleted: true });

    expect(await core.getTrace("tr-delete")).toBeNull();
    expect(db!.repos.traces.searchByText('"sensitive-delete-marker"', 10)).toEqual([]);
    expect(db!.repos.episodes.getById("ep-delete")!.traceIds).toEqual(["tr-keep"]);
  });

  it("subscribeEvents fires on session.opened", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    const received: string[] = [];
    const unsub = core.subscribeEvents((e) => {
      received.push(e.type);
    });
    await core.openSession({ agent: "openclaw", sessionId: "sub-test" });
    expect(received).toContain("session.opened");
    unsub();
  });

  it("shutdown is idempotent", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    await core.shutdown();
    await core.shutdown(); // Safe.
    await expect(core.openSession({ agent: "openclaw" })).rejects.toMatchObject({
      code: "already_shut_down",
    });
  });
});

describe("bootstrapMemoryCore", () => {
  let home: TmpHomeContext | null = null;

  afterEach(async () => {
    if (core) {
      try {
        await core.shutdown();
      } catch {
        /* ignore */
      }
      core = null;
      pipeline = null;
    }
    await home?.cleanup();
    home = null;
  });

  it("boots a MemoryCore from tmp home + default config", async () => {
    home = await makeTmpHome({ agent: "openclaw" });
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "bootstrap-test",
    });
    const h = await core.health();
    expect(h.ok).toBe(false); // Not initialized yet.
    await core.init();
    const h2 = await core.health();
    expect(h2.ok).toBe(true);
    expect(h2.paths.home).toBe(home!.home.root);
    expect(h2.paths.db).toBe(home!.home.dbFile);
  });

  it("init() recovers orphaned open episodes left behind by a previous crash", async () => {
    // When the host (OpenClaw / Hermes / a daemon) is hard-killed
    // mid-conversation, no `session.end` event is fired and the open
    // episode rows in SQLite never get closed. `core.init()` now keeps
    // incomplete recent topics open so the next user turn can be routed
    // back into the same task, while repairing rows that already carry
    // a completed/scored signal:
    //
    //   - Already-rewarded rows (`r_task != null`) → close + stamp
    //     `closeReason="finalized"` (the chain ran to completion before
    //     the crash; only the final status flip was lost).
    //   - Un-scored rows with no traces → stay open + `topicState`
    //     `interrupted` so they do not show as skipped.
    home = await makeTmpHome({ agent: "openclaw" });

    // First bootstrap: lets migrations run + schema exists. Shut it
    // down cleanly so we can seed orphans into the DB without holding
    // a write lock.
    const seeder = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "orphan-test-seed",
    });
    await seeder.init();
    await seeder.shutdown();

    // Seed two open episodes directly via SQLite — one that has been
    // partially scored (rTask set) and one that hasn't.
    const Sqlite = (await import("better-sqlite3")).default;
    const writeDb = new Sqlite(home.home.dbFile);
    const orphanOldTs = Date.now() - 60 * 60 * 1000; // 1h ago
    writeDb
      .prepare(
        `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("se_orphan", "openclaw", orphanOldTs, orphanOldTs, "{}");
    writeDb
      .prepare(
        `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, NULL, '[]', NULL, 'open', '{}')`,
      )
      .run("ep_orphan_unscored", "se_orphan", orphanOldTs);
    writeDb
      .prepare(
        `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, NULL, '[]', ?, 'open', '{}')`,
      )
      .run("ep_orphan_scored", "se_orphan", orphanOldTs, 0.7);
    writeDb.close();

    // Second bootstrap + init — recovery fires inside init().
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "orphan-test-recover",
    });
    await core.init();

    const readDb = new Sqlite(home.home.dbFile, { readonly: true });
    const unscored = readDb
      .prepare("SELECT status, meta_json FROM episodes WHERE id = ?")
      .get("ep_orphan_unscored") as
      | { status: string; meta_json: string }
      | undefined;
    const scored = readDb
      .prepare("SELECT status, meta_json FROM episodes WHERE id = ?")
      .get("ep_orphan_scored") as
      | { status: string; meta_json: string }
      | undefined;
    readDb.close();

    expect(unscored).toBeDefined();
    expect(unscored!.status).toBe("open");
    const unscoredMeta = JSON.parse(unscored!.meta_json) as {
      closeReason?: string;
      abandonReason?: string;
      topicState?: string;
      pauseReason?: string;
    };
    expect(unscoredMeta.topicState).toBe("interrupted");
    expect(unscoredMeta.pauseReason).toBe("startup_recovered_open_topic");
    expect(unscoredMeta.closeReason).toBeUndefined();
    expect(unscoredMeta.abandonReason).toBeFalsy();

    expect(scored).toBeDefined();
    expect(scored!.status).toBe("closed");
    const scoredMeta = JSON.parse(scored!.meta_json) as {
      closeReason?: string;
      abandonReason?: string;
    };
    // Already-scored rows become "finalized" (the chain ran), so the
    // viewer can show them as "已完成" instead of "已跳过".
    expect(scoredMeta.closeReason).toBe("finalized");
    expect(scoredMeta.abandonReason).toBeFalsy();
  });

  it("keeps an interrupted topic open across restart and appends the next same-topic turn", async () => {
    home = await makeTmpHome({ agent: "openclaw" });

    const first = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "topic-recover-1",
    });
    await first.init();
    const firstStart = await first.onTurnStart({
      agent: "openclaw",
      sessionId: "se_topic_a" as never,
      userText: "帮我配置 Hermes viewer 端口 18800",
      ts: Date.now(),
    });
    const episodeId = firstStart.query.episodeId;
    expect(episodeId).toBeTruthy();
    await first.shutdown();

    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "topic-recover-2",
    });
    await core.init();
    const secondStart = await core.onTurnStart({
      agent: "openclaw",
      sessionId: "se_topic_b" as never,
      userText: "那这个端口继续怎么验证",
      ts: Date.now() + 1_000,
    });

    expect(secondStart.query.episodeId).toBe(episodeId);
    const rows = await core.listEpisodeRows({ limit: 10 });
    const row = rows.find((r) => r.id === episodeId);
    expect(row?.status).toBe("open");
    expect(row?.topicState === "active" || row?.topicState === "interrupted").toBe(true);
    expect(row?.preview).toContain("Hermes viewer");
  });

  it("rescoring closed episodes when traces were appended after the last reward", async () => {
    home = await makeTmpHome({ agent: "openclaw" });

    const seeder = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "dirty-rescore-seed",
    });
    await seeder.init();
    await seeder.shutdown();

    const Sqlite = (await import("better-sqlite3")).default;
    const writeDb = new Sqlite(home.home.dbFile);
    const ts = Date.now() - 1_000;
    writeDb
      .prepare(
        `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("se_dirty", "openclaw", ts, ts, "{}");
    writeDb
      .prepare(
        `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, ?, ?, ?, 'closed', ?)`,
      )
      .run(
        "ep_dirty",
        "se_dirty",
        ts,
        ts + 1,
        JSON.stringify(["tr_dirty"]),
        0.7,
        JSON.stringify({
          closeReason: "finalized",
          reward: { rHuman: 0.7, scoredAt: ts - 500 },
        }),
      );
    writeDb
      .prepare(
        `INSERT INTO traces (
          id, episode_id, session_id, ts, user_text, agent_text, summary,
          tool_calls_json, reflection, agent_thinking, value, alpha, r_human,
          priority, tags_json, error_signatures_json, vec_summary, vec_action,
          share_scope, share_target, shared_at, turn_id, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        "tr_dirty",
        "ep_dirty",
        "se_dirty",
        ts,
        "请继续解释这个数据集的建模任务和目标变量，说明为什么它是回归问题。",
        "这是一个房价预测回归任务，目标变量 SalePrice 是连续数值，需要根据房屋特征预测价格。",
        "房价预测回归任务说明",
        "[]",
        null,
        null,
        0,
        0,
        null,
        0.5,
        "[]",
        "[]",
        ts,
        1,
      );
    writeDb.close();

    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "dirty-rescore-recover",
    });
    await core.init();

    const readDb = new Sqlite(home.home.dbFile, { readonly: true });
    const episode = readDb
      .prepare("SELECT r_task, meta_json FROM episodes WHERE id = ?")
      .get("ep_dirty") as { r_task: number | null; meta_json: string } | undefined;
    readDb.close();

    expect(episode).toBeDefined();
    expect(episode!.r_task).toBe(0);
    const meta = JSON.parse(episode!.meta_json) as {
      rewardDirty?: unknown;
      recoveryReason?: string;
      reward?: { traceCount?: number; traceIds?: string[] };
    };
    expect(meta.rewardDirty).toBeUndefined();
    expect(meta.recoveryReason).toBe("dirty_reward_rescore");
    expect(meta.reward?.traceCount).toBe(1);
    expect(meta.reward?.traceIds).toEqual(["tr_dirty"]);
  });

  it("rescoring finalized closed episodes that have traces but no reward metadata", async () => {
    home = await makeTmpHome({ agent: "openclaw" });

    const seeder = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "missing-reward-seed",
    });
    await seeder.init();
    await seeder.shutdown();

    const Sqlite = (await import("better-sqlite3")).default;
    const writeDb = new Sqlite(home.home.dbFile);
    const ts = Date.now() - 1_000;
    writeDb
      .prepare(
        `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("se_missing_reward", "openclaw", ts, ts, "{}");
    writeDb
      .prepare(
        `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, ?, ?, ?, 'closed', ?)`,
      )
      .run(
        "ep_missing_reward",
        "se_missing_reward",
        ts,
        ts + 1,
        JSON.stringify(["tr_missing_reward"]),
        null,
        JSON.stringify({ closeReason: "finalized", recoveryReason: "missed_session_end" }),
      );
    writeDb
      .prepare(
        `INSERT INTO traces (
          id, episode_id, session_id, ts, user_text, agent_text, summary,
          tool_calls_json, reflection, agent_thinking, value, alpha, r_human,
          priority, tags_json, error_signatures_json, vec_summary, vec_action,
          share_scope, share_target, shared_at, turn_id, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        "tr_missing_reward",
        "ep_missing_reward",
        "se_missing_reward",
        ts,
        "上海骨科医院推荐",
        "上海六院、长征医院、华山医院等骨科较强，可按创伤、脊柱、手外科方向选择。",
        "上海骨科医院推荐",
        "[]",
        null,
        null,
        0,
        0,
        null,
        0.5,
        "[]",
        "[]",
        ts,
        1,
      );
    writeDb.close();

    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "missing-reward-recover",
    });
    await core.init();

    const readDb = new Sqlite(home.home.dbFile, { readonly: true });
    const episode = readDb
      .prepare("SELECT r_task, meta_json FROM episodes WHERE id = ?")
      .get("ep_missing_reward") as { r_task: number | null; meta_json: string } | undefined;
    readDb.close();

    expect(episode).toBeDefined();
    expect(episode!.r_task).toBe(0);
    const meta = JSON.parse(episode!.meta_json) as {
      recoveryReason?: string;
      reward?: { traceCount?: number; traceIds?: string[] };
    };
    expect(meta.recoveryReason).toBe("dirty_reward_rescore");
    expect(meta.reward?.traceCount).toBe(1);
    expect(meta.reward?.traceIds).toEqual(["tr_missing_reward"]);
  });
});
