/**
 * MemoryCore façade tests.
 *
 * We drive the façade through its public interface (the shape adapters
 * see). The pipeline is wrapped directly via `createMemoryCore` with a
 * hand-built `PipelineHandle` so we control clocks + providers.
 */

import net from "node:net";

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
import {
  __resetHostLlmBridgeForTests,
  type HostLlmBridge,
} from "../../../core/llm/index.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { makeTmpHome, type TmpHomeContext } from "../../helpers/tmp-home.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";
import type { MemosError } from "../../../agent-contract/errors.js";
import type { SkillId, SkillRow, TraceRow } from "../../../core/types.js";

let db: TmpDbHandle | null = null;
let pipeline: PipelineHandle | null = null;
let core: MemoryCore | null = null;
const TEST_EMBED_DIMENSIONS = 384;
const FULL_MEMORY_CONFIG_YAML = `
version: 1
algorithm:
  lightweightMemory:
    enabled: false
`;

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
  config: typeof DEFAULT_CONFIG = configWithLightweightMemory(false),
): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-mc-test"),
    config,
    db: h.db,
    repos: h.repos,
    llm: null,
    reflectLlm: null,
    embedder: fakeEmbedder({ dimensions: TEST_EMBED_DIMENSIONS }),
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function seedCoreSkill(id: string, name: string): void {
  const row: SkillRow = {
    id: id as SkillId,
    ownerAgentKind: "openclaw",
    ownerProfileId: "main",
    ownerWorkspaceId: null,
    name,
    status: "active",
    invocationGuide: `${name}\n\nFollow the proven procedure.`,
    procedureJson: null,
    eta: 0.9,
    support: 3,
    gain: 0.3,
    trialsAttempted: 0,
    trialsPassed: 0,
    sourcePolicyIds: [],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: null,
    createdAt: 1_700_000_000_000 as SkillRow["createdAt"],
    updatedAt: 1_700_000_000_000 as SkillRow["updatedAt"],
    version: 1,
  };
  db!.repos.skills.upsert(row);
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
  __resetHostLlmBridgeForTests();
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
    expect(h.embedder.dim).toBe(TEST_EMBED_DIMENSIONS);
    expect(h.llm.available).toBe(false);
  });

  it("reloads the hub runtime when hub config changes without a process restart", async () => {
    const home = await makeTmpHome({
      agent: "openclaw",
      configYaml: "version: 1\nhub:\n  enabled: false\n",
    });
    try {
      pipeline = createPipeline({
        ...buildDeps(db!),
        home: home.home,
        config: home.config,
      });
      core = createMemoryCore(pipeline, home.home, "test");
      await core.init();
      await expect(core.hubAdminSnapshot!()).resolves.toMatchObject({ enabled: false });

      const port = await freePort();
      await core.patchConfig({
        hub: {
          enabled: true,
          role: "hub",
          port,
          teamName: "Live Reload",
          teamToken: "live-reload-secret",
        },
      });

      const snapshot = await core.hubAdminSnapshot!() as Record<string, unknown>;
      expect(snapshot).toMatchObject({
        enabled: true,
        role: "hub",
        status: "running",
        url: `http://127.0.0.1:${port}`,
      });
      const info = await fetch(`http://127.0.0.1:${port}/api/v1/hub/info`);
      expect(info.status).toBe(200);
      await expect(info.json()).resolves.toMatchObject({ teamName: "Live Reload" });
    } finally {
      if (core) {
        await core.shutdown();
        core = null;
        pipeline = null;
      }
      await home.cleanup();
    }
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

  it("repairs missing and wrong-dimension imported trace embeddings", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    await core.importBundle({
      version: 1,
      traces: [
        {
          id: "tr_imported",
          episodeId: "ep_imported",
          sessionId: "se_imported",
          ts: 1_700_000_000_000,
          userText: "imported memory text",
          agentText: "assistant answer",
          summary: "imported memory summary",
          toolCalls: [],
          value: 0,
          alpha: 0,
          priority: 0,
          turnId: 1_700_000_000_000,
        },
      ],
    });

    const before = await core.embeddingMaintenanceStats();
    expect(before.byKind.trace.missing).toBe(2);

    const repaired = await core.rebuildEmbeddings({ mode: "repair", limit: 10 });
    expect(repaired.updated).toBe(2);
    expect(repaired.statsAfter.needsRepair).toBe(0);
    let row = db!.repos.traces.getById("tr_imported" as never);
    expect(row?.vecSummary?.length).toBe(TEST_EMBED_DIMENSIONS);
    expect(row?.vecAction?.length).toBe(TEST_EMBED_DIMENSIONS);

    db!.repos.traces.updateVector(
      "tr_imported" as never,
      "vecSummary",
      new Float32Array([1]),
    );
    const mismatch = await core.embeddingMaintenanceStats();
    expect(mismatch.dimMismatch).toBe(1);

    const fixed = await core.rebuildEmbeddings({ mode: "repair", limit: 10 });
    expect(fixed.statsAfter.dimMismatch).toBe(0);
    row = db!.repos.traces.getById("tr_imported" as never);
    expect(row?.vecSummary?.length).toBe(TEST_EMBED_DIMENSIONS);
  });

  it("does not require action vectors for lightweight memory traces", async () => {
    pipeline = createPipeline(buildDeps(db!, configWithLightweightMemory(true)));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    db!.repos.sessions.upsert({
      id: "se_lightweight",
      agent: "openclaw",
      ownerAgentKind: "openclaw",
      ownerProfileId: "main",
      ownerWorkspaceId: null,
      startedAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_000_000,
      meta: {},
    });
    db!.repos.episodes.insert({
      id: "ep_lightweight",
      sessionId: "se_lightweight",
      ownerAgentKind: "openclaw",
      ownerProfileId: "main",
      ownerWorkspaceId: null,
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_000_001,
      traceIds: ["tr_lightweight"] as never,
      rTask: null,
      status: "closed",
      meta: { lightweightMemory: true },
    });
    db!.repos.traces.insert({
      id: "tr_lightweight",
      episodeId: "ep_lightweight",
      sessionId: "se_lightweight",
      ownerAgentKind: "openclaw",
      ownerProfileId: "main",
      ownerWorkspaceId: null,
      ts: 1_700_000_000_000,
      userText: "What changed in the repo?",
      agentText: "The branch adds lightweight memory mode.",
      summary: "Repo branch lightweight memory change",
      share: null,
      toolCalls: [],
      agentThinking: null,
      reflection: null,
      value: 0,
      alpha: 0,
      rHuman: null,
      priority: 0.5,
      tags: ["lightweight_memory"],
      errorSignatures: [],
      vecSummary: new Float32Array(TEST_EMBED_DIMENSIONS),
      vecAction: null,
      turnId: 1_700_000_000_000,
      schemaVersion: 1,
    } as TraceRow);

    const before = await core.embeddingMaintenanceStats();
    expect(before.byKind.trace.totalSlots).toBe(1);
    expect(before.byKind.trace.ready).toBe(1);
    expect(before.byKind.trace.missing).toBe(0);
    expect(before.needsRepair).toBe(0);

    const repaired = await core.rebuildEmbeddings({ mode: "repair", limit: 10 });
    expect(repaired.processed).toBe(0);
    expect(repaired.updated).toBe(0);

    const rebuilt = await core.rebuildEmbeddings({ mode: "rebuild", limit: 10 });
    expect(rebuilt.processed).toBe(1);
    expect(rebuilt.updated).toBe(1);
    const row = db!.repos.traces.getById("tr_lightweight" as never);
    expect(row?.vecSummary?.length).toBe(TEST_EMBED_DIMENSIONS);
    expect(row?.vecAction).toBeNull();

    await expect(core.listEpisodes({ limit: 10 })).resolves.toEqual(["ep_lightweight"]);
    await expect(core.countEpisodes()).resolves.toBe(1);
    const episodeRows = await core.listEpisodeRows({ limit: 10 });
    expect(episodeRows).toHaveLength(1);
    expect(episodeRows[0]?.id).toBe("ep_lightweight");
    expect(episodeRows[0]?.preview).toContain("What changed in the repo?");

    const search = await core.searchMemory({
      agent: "openclaw",
      query: "lightweight memory mode",
      topK: { tier1: 0, tier2: 5, tier3: 0 },
    });
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits.map((hit) => hit.snippet).join("\n")).toContain("lightweight memory mode");
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

  it("scopes shared traces to creator, same framework, or hub team", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    const mainNs = { agentKind: "openclaw", profileId: "main" };
    const reviewerNs = { agentKind: "openclaw", profileId: "reviewer" };
    const hermesNs = { agentKind: "hermes", profileId: "default" };

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
    await core.shareTrace(ownerRows[0]!.id, { scope: "public" });

    await core.openSession({ agent: "openclaw", sessionId: "s-reviewer", namespace: reviewerNs });
    const sharedRows = await core.listTraces({ limit: 10 });
    expect(sharedRows).toHaveLength(1);
    expect(sharedRows[0]?.share?.scope).toBe("public");
    expect(await core.listTraces({ limit: 10, groupByTurn: true })).toHaveLength(1);

    await core.openSession({ agent: "hermes", sessionId: "s-hermes", namespace: hermesNs });
    expect(await core.listTraces({ limit: 10 })).toHaveLength(0);
    expect(await core.listTraces({ limit: 10, groupByTurn: true })).toHaveLength(0);

    await core.openSession({ agent: "openclaw", sessionId: "s-main", namespace: mainNs });
    await core.shareTrace(ownerRows[0]!.id, { scope: "hub" });

    await core.openSession({ agent: "hermes", sessionId: "s-hermes", namespace: hermesNs });
    const hubRows = await core.listTraces({ limit: 10 });
    expect(hubRows).toHaveLength(1);
    expect(hubRows[0]?.share?.scope).toBe("hub");
    expect(await core.listTraces({ limit: 10, groupByTurn: true })).toHaveLength(1);
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
    expect(scored.priority).toBeCloseTo(1 / 3);
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

  it("getSkill resolves colon-qualified skill ids and short aliases", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    seedCoreSkill("skillsbench:skill-a089bcb8e0258209", "skill-a089bcb8e0258209");
    seedCoreSkill("skill-local-only", "local skill");

    await expect(core.getSkill("skill-a089bcb8e0258209" as SkillId)).resolves.toMatchObject({
      id: "skillsbench:skill-a089bcb8e0258209",
      name: "skill-a089bcb8e0258209",
    });
    await expect(core.getSkill("skillsbench:skill-local-only" as SkillId)).resolves.toMatchObject({
      id: "skill-local-only",
      name: "local skill",
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

  it("persists lightweight summarizer model status for Hermes overview", async () => {
    home = await makeTmpHome({
      agent: "hermes",
      configYaml: `
llm:
  provider: host
  model: hermes-summary-test
algorithm:
  lightweightMemory:
    enabled: true
`,
    });
    const bridge: HostLlmBridge = {
      id: "test-host-llm",
      async complete() {
        return {
          text: JSON.stringify({ summary: "Hermes remembered the overview status fact" }),
          model: "hermes-summary-test",
          durationMs: 1,
        };
      },
    };
    core = await bootstrapMemoryCore({
      agent: "hermes",
      home: home.home,
      config: home.config,
      pkgVersion: "bootstrap-test",
      hostLlmBridge: bridge,
      now: () => 1_700_000_000_000,
    });
    await core.init();

    const start = await core.onTurnStart({
      agent: "hermes",
      sessionId: "hermes-lightweight-status",
      userText: "请记住 Hermes 摘要模型状态应该显示已调用",
      ts: 1_700_000_000_000,
    });
    await core.onTurnEnd({
      agent: "hermes",
      sessionId: "hermes-lightweight-status",
      episodeId: start.query.episodeId!,
      agentText: "已记住。",
      toolCalls: [],
      ts: 1_700_000_000_100,
    });

    const logs = await core.listApiLogs({ toolName: "system_model_status", limit: 10 });
    const llmRows = logs.logs
      .map((row) => JSON.parse(row.outputJson) as { role?: string; status?: string; op?: string })
      .filter((row) => row.role === "llm");
    expect(llmRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "ok",
          op: "capture.summarize",
        }),
      ]),
    );
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
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: FULL_MEMORY_CONFIG_YAML,
    });

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
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: FULL_MEMORY_CONFIG_YAML,
    });

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
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: FULL_MEMORY_CONFIG_YAML,
    });

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
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: FULL_MEMORY_CONFIG_YAML,
    });

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

  it("dirty-reward recovery does not insert orphan traces (regression: rescore loop guard)", async () => {
    // Regression test for the rescore loop:
    // When recoverDirtyClosedEpisodes re-emits episode.finalized, capture's
    // runReflect used to insert new trace rows for "orphan steps" — steps
    // whose timestamps didn't match any existing DB row.  For recovered
    // episodes this happens whenever a trace has tool calls with endedAt
    // timestamps different from the trace's own ts, because the snapshot
    // rebuilds a separate tool-role turn for each call.
    //
    // Without the guard the orphan insert grows trace_ids_json, keeping
    // reward.traceCount != traceIds.length forever and looping on every
    // bridge restart.  The guard (meta.recoveryReason === "dirty_reward_rescore")
    // skips the insert, so trace_ids_json stays stable and the episode
    // stops appearing dirty after a single recovery pass.

    home = await makeTmpHome({ agent: "openclaw" });

    const seeder = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "rescore-loop-seed",
    });
    await seeder.init();
    await seeder.shutdown();

    const Sqlite = (await import("better-sqlite3")).default;
    const writeDb = new Sqlite(home.home.dbFile);
    const BASE = Date.now() - 5_000;

    writeDb
      .prepare(
        `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("se_loop", "openclaw", BASE, BASE, "{}");

    // Episode is dirty: traceCount=1 but trace_ids_json has 2 IDs.
    writeDb
      .prepare(
        `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, ?, ?, ?, 'closed', ?)`,
      )
      .run(
        "ep_loop",
        "se_loop",
        BASE,
        BASE + 1,
        JSON.stringify(["tr_loop_a", "tr_loop_b"]),
        0.5,
        JSON.stringify({
          closeReason: "finalized",
          reward: { rHuman: 0.5, scoredAt: BASE - 1000, traceCount: 1 },
        }),
      );

    // tr_loop_a: plain text trace — no orphan risk.
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
        "tr_loop_a",
        "ep_loop",
        "se_loop",
        BASE,
        "帮我分析一下这段Python代码的性能瓶颈，并给出优化建议。",
        "这段代码的主要性能问题在于嵌套循环，时间复杂度是O(n²)，可以用哈希表将其优化到O(n)。",
        "Python代码性能分析",
        "[]",
        null,
        null,
        0,
        0,
        null,
        0.5,
        "[]",
        "[]",
        BASE,
        1,
      );

    // tr_loop_b: trace with a tool call whose endedAt differs from the trace ts.
    // snapshotFromRecoveredEpisode creates a tool-role turn with ts=BASE+300,
    // which does NOT appear in traceByTs (only BASE and BASE+100 are in the map).
    // Without the guard this step is treated as an orphan and a new trace is
    // inserted, growing trace_ids_json from 2 to 3 and keeping the episode dirty.
    const toolCallWithDifferentTs = JSON.stringify([
      {
        name: "bash",
        input: { command: "python -c 'import cProfile; cProfile.run(\"main()\")'"},
        output: "ncalls tottime ... main 1 0.003",
        endedAt: BASE + 300,
      },
    ]);
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
        "tr_loop_b",
        "ep_loop",
        "se_loop",
        BASE + 100,
        "请用cProfile验证一下",
        "运行结果确认了瓶颈在内层循环，优化后耗时减少了约80%。",
        "cProfile性能验证",
        toolCallWithDifferentTs,
        null,
        null,
        0,
        0,
        null,
        0.5,
        "[]",
        "[]",
        BASE + 100,
        1,
      );
    writeDb.close();

    // First recovery: episode is dirty (traceCount=1 != ids_len=2).
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "rescore-loop-recover-1",
    });
    await core.init();
    await core.shutdown();
    core = null;

    const readDb1 = new Sqlite(home.home.dbFile, { readonly: true });
    const ep1 = readDb1
      .prepare("SELECT trace_ids_json, meta_json, r_task FROM episodes WHERE id = ?")
      .get("ep_loop") as { trace_ids_json: string; meta_json: string; r_task: number | null } | undefined;
    readDb1.close();

    expect(ep1).toBeDefined();
    const ids1 = JSON.parse(ep1!.trace_ids_json) as string[];
    // Guard: no orphan trace was inserted during dirty-reward recovery.
    expect(ids1.length).toBe(2);
    const meta1 = JSON.parse(ep1!.meta_json) as {
      recoveryReason?: string;
      reward?: { traceCount?: number };
    };
    expect(meta1.recoveryReason).toBe(RECOVERY_REASONS.DIRTY_REWARD_RESCORE);
    // After recovery traceCount matches ids_len: episode is no longer dirty.
    expect(meta1.reward?.traceCount).toBe(2);

    // Second recovery (simulates next bridge restart): episode should not
    // be re-scored because traceCount(2) == trace_ids_json.length(2).
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "rescore-loop-recover-2",
    });
    await core.init();

    const readDb2 = new Sqlite(home.home.dbFile, { readonly: true });
    const ep2 = readDb2
      .prepare("SELECT trace_ids_json, meta_json FROM episodes WHERE id = ?")
      .get("ep_loop") as { trace_ids_json: string; meta_json: string } | undefined;
    readDb2.close();

    expect(ep2).toBeDefined();
    const ids2 = JSON.parse(ep2!.trace_ids_json) as string[];
    // Still 2 — no new orphan inserts on the second restart.
    expect(ids2.length).toBe(2);
    const meta2 = JSON.parse(ep2!.meta_json) as {
      reward?: { traceCount?: number };
    };
    // traceCount unchanged: the episode was not re-scored.
    expect(meta2.reward?.traceCount).toBe(2);
  });
});
