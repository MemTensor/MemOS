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
import { RECOVERY_REASONS } from "../../../core/pipeline/recovery-constants.js";
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

  // Regression for #2131: viewer dashboard counts must not "drift to
  // zero" when a turn/session from a different sub-agent profile flips
  // the core's active namespace. The viewer is a local single-user
  // admin surface, so its aggregate reads pass `includeAllNamespaces`
  // (same convention as diag.ts / session.ts routes) and must stay
  // stable regardless of which namespace processed the last turn.
  it("keeps metrics + listEpisodes stable across a namespace flip (includeAllNamespaces)", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    const mainNs = { agentKind: "openclaw", profileId: "main" };
    const subagentNs = { agentKind: "openclaw", profileId: "subagent-x" };

    // 1. A turn under the boot namespace writes one memory.
    const start = await core.onTurnStart({
      agent: "openclaw",
      namespace: mainNs,
      sessionId: "s-main",
      userText: "remember the deploy checklist",
      ts: 1_700_000_000_001,
    });
    await core.onTurnEnd({
      agent: "openclaw",
      namespace: mainNs,
      sessionId: "s-main",
      episodeId: start.query.episodeId!,
      agentText: "stored the deploy checklist",
      toolCalls: [],
      ts: 1_700_000_000_002,
    });

    const before = await core.metrics({ days: 1, includeAllNamespaces: true });
    expect(before.total).toBe(1);
    const episodesBefore = await core.listEpisodes({
      limit: 10,
      includeAllNamespaces: true,
    });
    expect(episodesBefore).toHaveLength(1);

    // 2. A session under a DIFFERENT profile flips activeNamespace
    // (this is what the gateway/sub-agents do in production).
    await core.openSession({
      agent: "openclaw",
      sessionId: "s-sub",
      namespace: subagentNs,
    });

    // Namespace-scoped reads hide the other profile's row (intended
    // multi-profile isolation)…
    const scoped = await core.metrics({ days: 1 });
    expect(scoped.total).toBe(0);
    await expect(core.listEpisodes({ limit: 10 })).resolves.toHaveLength(0);

    // …but the viewer's all-namespace reads must NOT drift.
    const after = await core.metrics({ days: 1, includeAllNamespaces: true });
    expect(after.total).toBe(1);
    const episodesAfter = await core.listEpisodes({
      limit: 10,
      includeAllNamespaces: true,
    });
    expect(episodesAfter).toHaveLength(1);
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
    // Issue #1808: orphan recovery runs on a background promise; await
    // it so the test reads SQLite after every meta / reward write
    // settles, not just the synchronous ones.
    await core.waitForStartupRecovery?.();

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
    // Issue #1808: orphan/dirty recovery now runs on a background
    // promise so `init()` returns to the host instantly. Tests that
    // assert side effects from the recovery chain must await the
    // promise explicitly.
    await core.waitForStartupRecovery?.();

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
    expect(meta.recoveryReason).toBe(RECOVERY_REASONS.DIRTY_REWARD_RESCORE);
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
    // Issue #1808: orphan/dirty recovery now runs on a background
    // promise; tests asserting recovery side effects must await it.
    await core.waitForStartupRecovery?.();

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
    expect(meta.recoveryReason).toBe(RECOVERY_REASONS.DIRTY_REWARD_RESCORE);
    expect(meta.reward?.traceCount).toBe(1);
    expect(meta.reward?.traceIds).toEqual(["tr_missing_reward"]);
  });

  it("init() returns immediately even when a stale orphan's recovery chain stalls (issue #1808)", async () => {
    // Issue #1808: on databases with 30k+ traces, the dreaming chain
    // synchronous-await inside `init()` blocked the OpenClaw Gateway's
    // event loop for 3-5s+, timing out the 3s WebSocket read probe.
    // We now run the recovery chain on a background promise so
    // `init()` resolves in milliseconds regardless of the chain's
    // worst-case latency.
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: FULL_MEMORY_CONFIG_YAML,
    });

    const seeder = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "issue1808-init-latency-seed",
    });
    await seeder.init();
    await seeder.shutdown();

    const Sqlite = (await import("better-sqlite3")).default;
    const writeDb = new Sqlite(home.home.dbFile);
    const orphanOldTs = Date.now() - 5 * 60 * 60 * 1000; // 5h ago > STALE_EPISODE_TIMEOUT_MS
    writeDb
      .prepare(
        `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("se_issue1808", "openclaw", orphanOldTs, orphanOldTs, "{}");
    for (let i = 0; i < 3; i++) {
      writeDb
        .prepare(
          `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, NULL, '[]', NULL, 'open', '{}')`,
        )
        .run(`ep_issue1808_${i}`, "se_issue1808", orphanOldTs);
    }
    writeDb.close();

    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "issue1808-init-latency-recover",
    });

    // Measure how long `init()` itself takes. Even with three stale
    // orphans queued for the background reflect/reward chain it must
    // resolve well under the OpenClaw Gateway's 3s WebSocket read
    // probe budget.
    const startedAt = Date.now();
    await core.init();
    const initMs = Date.now() - startedAt;
    expect(initMs).toBeLessThan(500);

    // The background promise is still in flight (or just finished);
    // either way `waitForStartupRecovery()` must resolve.
    await core.waitForStartupRecovery?.();
  });

  it("dirty closed episodes hit a failure-count backoff so init() does not retry them every restart (issue #1808)", async () => {
    // The OpenClaw report noted "orphan episodes with failed LLM calls
    // are retried indefinitely with no backoff". After the third
    // consecutive failure we suspend automatic retries until the
    // exponential backoff window elapses; manual feedback is the only
    // way to force another rescore inside the window.
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: FULL_MEMORY_CONFIG_YAML,
    });

    const seeder = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "issue1808-backoff-seed",
    });
    await seeder.init();
    await seeder.shutdown();

    const Sqlite = (await import("better-sqlite3")).default;
    const writeDb = new Sqlite(home.home.dbFile);
    const ts = Date.now() - 2_000;
    writeDb
      .prepare(
        `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("se_backoff", "openclaw", ts, ts, "{}");
    // Seed a closed episode that is "dirty" by predicate (r_task=null
    // + finalized + traceIds.length>0) but whose meta.rewardDirty
    // already records 3 prior failures with `lastFailureAt = now` —
    // i.e. inside the 1h backoff window.
    writeDb
      .prepare(
        `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, ?, ?, ?, 'closed', ?)`,
      )
      .run(
        "ep_backoff",
        "se_backoff",
        ts,
        ts + 1,
        JSON.stringify(["tr_backoff"]),
        null,
        JSON.stringify({
          closeReason: "finalized",
          recoveryReason: "missed_session_end",
          rewardDirty: { failedAttempts: 3, lastFailureAt: Date.now() },
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
        "tr_backoff",
        "ep_backoff",
        "se_backoff",
        ts,
        "需求澄清问题",
        "好的，分阶段回答。",
        "需求澄清问题",
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
      pkgVersion: "issue1808-backoff-recover",
    });
    await core.init();
    await core.waitForStartupRecovery?.();

    const readDb = new Sqlite(home.home.dbFile, { readonly: true });
    const episode = readDb
      .prepare("SELECT r_task, meta_json FROM episodes WHERE id = ?")
      .get("ep_backoff") as { r_task: number | null; meta_json: string } | undefined;
    readDb.close();

    expect(episode).toBeDefined();
    // The episode is still inside the backoff window, so the rescan
    // skipped it — r_task should stay null (the original failing
    // value), and the recovery-reason stamp from `recoverDirtyClosedEpisodes`
    // should NOT be present.
    expect(episode!.r_task).toBeNull();
    const meta = JSON.parse(episode!.meta_json) as {
      recoveryReason?: string;
      rewardDirty?: { failedAttempts?: number; lastFailureAt?: number };
    };
    expect(meta.recoveryReason).toBe("missed_session_end");
    expect(meta.rewardDirty?.failedAttempts).toBe(3);
  });

  it("recoverDirtyClosedEpisodes bumps failedAttempts when the rescore did not lift the dirty flag (issue #1808)", async () => {
    // After `recoverDirtyClosedEpisodes` finishes its flush, any
    // episode still marked dirty has its `meta.rewardDirty` failure
    // counter bumped + `lastFailureAt` stamped. Once `failedAttempts`
    // crosses MAX_DIRTY_REWARD_ATTEMPTS the backoff filter kicks in
    // on subsequent scans.
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: FULL_MEMORY_CONFIG_YAML,
    });

    const seeder = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "issue1808-counter-seed",
    });
    await seeder.init();
    await seeder.shutdown();

    const Sqlite = (await import("better-sqlite3")).default;
    const writeDb = new Sqlite(home.home.dbFile);
    const ts = Date.now() - 2_000;
    writeDb
      .prepare(
        `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("se_counter", "openclaw", ts, ts, "{}");
    // A dirty episode with NO prior failure counter. Without a working
    // LLM the reward listener cannot lift r_task above null → the
    // episode stays dirty after recovery → failedAttempts should jump
    // from 0 → 1.
    writeDb
      .prepare(
        `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, ?, ?, ?, 'closed', ?)`,
      )
      .run(
        "ep_counter",
        "se_counter",
        ts,
        ts + 1,
        JSON.stringify(["tr_counter"]),
        null,
        JSON.stringify({
          closeReason: "finalized",
          recoveryReason: "missed_session_end",
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
        "tr_counter",
        "ep_counter",
        "se_counter",
        ts,
        "请帮我详细分析 1808 issue 的根因：为什么 memos-local-plugin 的梦境处理会饿死 OpenClaw 网关的事件循环？说明同步 LLM 调用与 await 之间的关系。",
        "OpenClaw Gateway 进程是单线程 Node.js 事件循环。memos-local-plugin 在 init 同步等待 reflect/reward 链 → 阻塞事件循环 3-5s → WebSocket 升级超时。",
        "OpenClaw Gateway 与 memos-local-plugin 事件循环阻塞根因分析",
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

    // The fakeEmbedder default is used, no LLM is configured (provider="")
    // → reward listener resolves with r_task still null (LLM_UNAVAILABLE
    // → heuristic fallback writes r_task=0 if it runs; if it cannot run
    // we still expect the dirty flag to survive).
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "issue1808-counter-recover",
    });
    await core.init();
    await core.waitForStartupRecovery?.();

    const readDb = new Sqlite(home.home.dbFile, { readonly: true });
    const episode = readDb
      .prepare("SELECT r_task, meta_json FROM episodes WHERE id = ?")
      .get("ep_counter") as { r_task: number | null; meta_json: string } | undefined;
    readDb.close();

    expect(episode).toBeDefined();
    const meta = JSON.parse(episode!.meta_json) as {
      rewardDirty?: { failedAttempts?: number; lastFailureAt?: number };
      reward?: { traceCount?: number; skipped?: boolean };
    };
    // Three possible end-states from the reward listener depending on
    // the heuristic fallback's behaviour:
    //   1. r_task=0, reward.traceCount matches  → no longer dirty → backoff cleared
    //   2. r_task=null, reward.skipped=true     → no longer dirty (skipped path) → backoff cleared
    //   3. r_task=null, no reward written       → still dirty → failedAttempts bumped to 1
    // In all three cases the *invariant* is "no backoff metadata
    // remains if the rescore stopped being dirty, AND failedAttempts
    // increases by exactly 1 if it stayed dirty".
    if (episode!.r_task !== null || meta.reward?.skipped === true) {
      expect(meta.rewardDirty).toBeUndefined();
    } else {
      expect(meta.rewardDirty?.failedAttempts).toBe(1);
      expect(typeof meta.rewardDirty?.lastFailureAt).toBe("number");
    }
  });

  it("shutdown() awaits background recovery before tearing down storage (issue #1808)", async () => {
    // If `shutdown()` did not await the background recovery promise we
    // would close SQLite while the reflect / reward listeners were
    // still mid-`handle.flush()`, producing `SQLITE_MISUSE` noise.
    // Sequential init → shutdown back-to-back must complete cleanly
    // without throwing.
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: FULL_MEMORY_CONFIG_YAML,
    });

    const seeder = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "issue1808-shutdown-seed",
    });
    await seeder.init();
    await seeder.shutdown();

    const Sqlite = (await import("better-sqlite3")).default;
    const writeDb = new Sqlite(home.home.dbFile);
    const ts = Date.now() - 2_000;
    writeDb
      .prepare(
        `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("se_shutdown", "openclaw", ts, ts, "{}");
    writeDb
      .prepare(
        `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, ?, ?, ?, 'closed', ?)`,
      )
      .run(
        "ep_shutdown",
        "se_shutdown",
        ts,
        ts + 1,
        JSON.stringify(["tr_shutdown"]),
        null,
        JSON.stringify({
          closeReason: "finalized",
          recoveryReason: "missed_session_end",
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
        "tr_shutdown",
        "ep_shutdown",
        "se_shutdown",
        ts,
        "shutdown 测试",
        "好的。",
        "shutdown 测试",
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

    const fastCore = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "issue1808-shutdown-recover",
    });
    await fastCore.init();
    // Deliberately skip `waitForStartupRecovery()`. `shutdown()` must
    // still complete the recovery before closing the DB handle.
    await expect(fastCore.shutdown()).resolves.toBeUndefined();
  });

  it("does not rescore a closed episode whose only mismatch is a ghost trace ID (#1966)", async () => {
    // Regression guard for https://github.com/MemTensor/MemOS/issues/1966.
    // A dangling ID in trace_ids_json must not make reward coverage look dirty
    // forever; only trace rows that still exist should count.
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: FULL_MEMORY_CONFIG_YAML,
    });

    const seeder = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "ghost-trace-seed",
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
      .run("se_ghost", "openclaw", ts, ts, "{}");
    writeDb
      .prepare(
        `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, ?, ?, ?, 'closed', ?)`,
      )
      .run(
        "ep_ghost",
        "se_ghost",
        ts,
        ts + 1,
        JSON.stringify(["tr_real", "tr_ghost"]),
        0.6,
        JSON.stringify({
          closeReason: "finalized",
          reward: {
            rHuman: 0.6,
            scoredAt: ts + 2,
            traceCount: 1,
            traceIds: ["tr_real"],
            source: "heuristic",
          },
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
        "tr_real",
        "ep_ghost",
        "se_ghost",
        ts,
        "请讲一下回归任务的损失函数选择。",
        "对连续目标变量常用 MSE 或 MAE；存在重尾噪声时用 Huber。",
        "回归任务损失函数",
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
      pkgVersion: "ghost-trace-recover",
    });
    await core.init();
    await core.waitForStartupRecovery?.();

    const readDb = new Sqlite(home.home.dbFile, { readonly: true });
    const episode = readDb
      .prepare("SELECT r_task, meta_json FROM episodes WHERE id = ?")
      .get("ep_ghost") as { r_task: number | null; meta_json: string } | undefined;
    readDb.close();

    expect(episode).toBeDefined();
    expect(episode!.r_task).toBeCloseTo(0.6);
    const meta = JSON.parse(episode!.meta_json) as {
      rewardDirty?: unknown;
      recoveryReason?: string;
      reward?: { rHuman?: number; traceCount?: number; traceIds?: string[] };
    };
    expect(meta.recoveryReason).toBeUndefined();
    expect(meta.reward?.rHuman).toBeCloseTo(0.6);
    expect(meta.reward?.traceCount).toBe(1);
    expect(meta.reward?.traceIds).toEqual(["tr_real"]);
  });
});
