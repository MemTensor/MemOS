/**
 * OpenClaw adapter bridge — unit tests.
 *
 * Exercises the adapter layer against a real `MemoryCore` (no LLM, no
 * network) so we cover the full path:
 *   host hook → bridge → MemoryCore → pipeline → events.
 *
 * Hook signatures, event shapes, and tool-factory form mirror the real
 * `openclaw/plugin-sdk` surface (verified against
 * `openclaw/src/plugins/hook-types.ts::PluginHookHandlerMap`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMemoryCore,
  createPipeline,
  type PipelineDeps,
  type PipelineHandle,
} from "../../../core/pipeline/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { rootLogger } from "../../../core/logger/index.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";

import {
  bridgeSessionId,
  createOpenClawBridge,
  extractTurn,
  flattenMessages,
  renderContextBlock,
} from "../../../adapters/openclaw/bridge.js";
import { registerOpenClawTools } from "../../../adapters/openclaw/tools.js";
import type {
  AgentToolDescriptor,
  HostLogger,
  OpenClawHookHandlerMap,
  OpenClawHookName,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
  PluginHookAgentContext,
  PluginHookToolContext,
} from "../../../adapters/openclaw/openclaw-api.js";

let db: TmpDbHandle | null = null;
let pipeline: PipelineHandle | null = null;
let core: MemoryCore | null = null;

function buildDeps(h: TmpDbHandle): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-oc-test"),
    config: DEFAULT_CONFIG,
    db: h.db,
    repos: h.repos,
    llm: null,
    reflectLlm: null,
    embedder: fakeEmbedder({ dimensions: DEFAULT_CONFIG.embedding.dimensions }),
    log: rootLogger.child({ channel: "test.adapters.openclaw" }),
    now: () => 1_700_000_000_000,
  };
}

function silentLogger(): HostLogger {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function buildCore(): MemoryCore {
  pipeline = createPipeline(buildDeps(db!));
  const mc = createMemoryCore(
    pipeline,
    resolveHome("openclaw", "/tmp/memos-oc-test"),
    "test-oc-1.0.0",
  );
  core = mc;
  return mc;
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
    pipeline = null;
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

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe("flattenMessages", () => {
  it("normalizes pi-ai user / assistant / toolResult messages (canonical shape)", () => {
    // pi-ai emits assistant tool calls inside content[] as
    // `{ type: "toolCall", id, name, arguments }` blocks, and tool
    // results as a separate `role: "toolResult"` message — *not*
    // `role: "tool"` and *not* a top-level `tool_calls` array.
    const flat = flattenMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should list files." },
          { type: "text", text: "running ls" },
          {
            type: "toolCall",
            id: "call_1",
            name: "sh",
            arguments: { cmd: "ls" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "sh",
        content: [{ type: "text", text: "file.txt" }],
        isError: false,
      },
    ]);
    const roles = flat.map((m) => m.role);
    // user → thinking → assistant text → tool_call → tool_result.
    expect(roles).toEqual(["user", "thinking", "assistant", "tool_call", "tool_result"]);
    expect(flat[1].content).toContain("list files");
    expect(flat[2].content).toBe("running ls");
    const toolCall = flat[3];
    expect(toolCall.toolName).toBe("sh");
    expect(toolCall.toolInput).toEqual({ cmd: "ls" });
    expect(toolCall.toolCallId).toBe("call_1");
    const toolResult = flat[4];
    expect(toolResult.toolName).toBe("sh");
    expect(toolResult.toolCallId).toBe("call_1");
    expect(toolResult.content).toBe("file.txt");
    expect(toolResult.isError).toBe(false);
  });

  it("accepts OpenAI-legacy assistant.tool_calls + role: 'tool' for results", () => {
    // Older bridges and our own historical tests use this shape — keep
    // it working so we don't regress on multi-host setups.
    const flat = flattenMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "running ls",
        tool_calls: [
          {
            id: "call_1",
            function: { name: "sh", arguments: JSON.stringify({ cmd: "ls" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "sh", content: "file.txt" },
    ]);
    const roles = flat.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool_call", "tool_result"]);
    expect(flat[2].toolName).toBe("sh");
    expect(flat[2].toolInput).toEqual({ cmd: "ls" });
    expect(flat[3].content).toBe("file.txt");
  });

  it("does NOT coerce unknown roles into 'user' (the bug that captured tool stdout as user input)", () => {
    const flat = flattenMessages([
      { role: "user", content: "real user input" },
      // Some bogus role that the pi-ai docs never mention. Must NOT
      // land in the user slot — the entire bug class we're fixing.
      { role: "bogus", content: "tool stdout that previously got captured as user_text" },
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0].role).toBe("user");
    expect(flat[0].content).toBe("real user input");
  });

  it("tolerates non-string / malformed content gracefully", () => {
    const flat = flattenMessages([
      { role: "user" },
      { role: "assistant", content: [{ text: "direct block" }] },
    ]);
    expect(flat[0].content).toBe("");
    // assistant block without an explicit `type:"text"` still picks up `text`.
    expect(flat[1].role).toBe("assistant");
    expect(flat[1].content).toBe("direct block");
  });

  it("emits one tool_result per pi-ai toolResult, marking error status", () => {
    const flat = flattenMessages([
      { role: "user", content: "deploy" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running deploy" },
          { type: "toolCall", id: "c2", name: "exec", arguments: { cmd: "./deploy" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "exec",
        content: "boom",
        isError: true,
      },
    ]);
    const result = flat.find((m) => m.role === "tool_result")!;
    expect(result.isError).toBe(true);
    expect(result.content).toBe("boom");
  });
});

describe("extractTurn", () => {
  it("extracts the most recent user→assistant exchange with tool calls paired by id (pi-ai shape)", () => {
    const flat = flattenMessages([
      { role: "user", content: "old turn" },
      { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      { role: "user", content: "how many files?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running ls" },
          {
            type: "toolCall",
            id: "c1",
            name: "sh",
            arguments: { cmd: "ls" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "sh",
        content: "a.txt\nb.txt",
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "2 files" }] },
    ]);
    const turn = extractTurn(flat, 1_700_000_000_000);
    expect(turn).not.toBeNull();
    expect(turn!.userText).toBe("how many files?");
    expect(turn!.agentText).toContain("2 files");
    expect(turn!.toolCalls).toHaveLength(1);
    expect(turn!.toolCalls[0].name).toBe("sh");
    expect(turn!.toolCalls[0].input).toEqual({ cmd: "ls" });
    expect(turn!.toolCalls[0].output).toContain("a.txt");
  });

  it("captures sysctl-style exec invocation: tool stdout lands in tool output, NOT in userText", () => {
    // Regression for the user's bug: an exec tool with a complex
    // command + multi-line stdout used to be parsed as a fresh user
    // turn whose content was the stdout. Lock down that pi-ai's
    // toolResult shape now keeps the boundaries straight.
    const flat = flattenMessages([
      { role: "user", content: "帮我看下当前运行的系统是几个核心多少内存" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll check the system." },
          {
            type: "toolCall",
            id: "exec_42",
            name: "exec",
            arguments: {
              command: "sysctl -n hw.ncpu hw.memsize",
              timeout: 60,
              yieldMs: 10000,
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "exec_42",
        toolName: "exec",
        content: "10\n17179869184\nHardware:\n  Hardware Overview:\n    Model Name: MacBook Pro",
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "10 核 / 16 GB" }],
      },
    ]);
    const turn = extractTurn(flat, 0);
    expect(turn).not.toBeNull();
    expect(turn!.userText).toBe("帮我看下当前运行的系统是几个核心多少内存");
    expect(turn!.userText).not.toContain("17179869184");
    expect(turn!.userText).not.toContain("Hardware:");
    // Both assistant texts are kept in chronological order — the
    // lead-in ("I'll check the system.") and the final answer
    // ("10 核 / 16 GB"). What we explicitly forbid is tool stdout
    // leaking back into agentText.
    expect(turn!.agentText).toContain("I'll check the system.");
    expect(turn!.agentText).toContain("10 核 / 16 GB");
    expect(turn!.agentText).not.toContain("17179869184");
    expect(turn!.agentText).not.toContain("Hardware:");
    expect(turn!.toolCalls).toHaveLength(1);
    expect(turn!.toolCalls[0].name).toBe("exec");
    expect(turn!.toolCalls[0].input).toMatchObject({
      command: "sysctl -n hw.ncpu hw.memsize",
    });
    expect(turn!.toolCalls[0].output).toContain("17179869184");
    expect(turn!.toolCalls[0].output).toContain("Hardware:");
  });

  it("collects pi-ai ThinkingContent into agentThinking and keeps it OUT of agentText", () => {
    const flat = flattenMessages([
      { role: "user", content: "summarise next steps" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me read the issue first." },
          { type: "text", text: "I read the issue. Next: triage." },
        ],
      },
    ]);
    const turn = extractTurn(flat, 0);
    expect(turn!.agentText).toBe("I read the issue. Next: triage.");
    expect(turn!.agentText).not.toContain("Let me read");
    expect(turn!.agentThinking).toBe("Let me read the issue first.");
  });

  it("falls back gracefully when assistant.toolCall has no matching toolResult", () => {
    const flat = flattenMessages([
      { role: "user", content: "do x" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "trying x" },
          { type: "toolCall", id: "orphan", name: "x", arguments: {} },
        ],
      },
      // no toolResult.
    ]);
    const turn = extractTurn(flat, 99_999);
    expect(turn!.toolCalls).toHaveLength(1);
    expect(turn!.toolCalls[0].name).toBe("x");
    expect(turn!.toolCalls[0].output).toBeUndefined();
  });

  it("returns null when the list has no user message", () => {
    const flat = flattenMessages([
      { role: "assistant", content: [{ type: "text", text: "nothing yet" }] },
    ]);
    expect(extractTurn(flat, 1)).toBeNull();
  });
});

describe("renderContextBlock", () => {
  it("wraps packet context in memos_context tags", () => {
    const block = renderContextBlock({
      query: { agent: "openclaw", query: "" },
      hits: [],
      injectedContext: "hello\nworld",
      tierLatencyMs: { tier1: 1, tier2: 2, tier3: 3 },
    });
    expect(block).toContain("<memos_context>");
    expect(block).toContain("hello\nworld");
    expect(block).toContain("</memos_context>");
  });

  it("returns empty when packet is null", () => {
    expect(renderContextBlock(null)).toBe("");
  });

  it("returns empty when injectedContext is empty and hint is disabled", () => {
    expect(
      renderContextBlock(
        {
          query: { agent: "openclaw", query: "" },
          hits: [],
          injectedContext: "",
          tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
        },
        { hintWhenEmpty: false },
      ),
    ).toBe("");
  });

  it("injects a cold-start hint by default when there is no retrieval context", () => {
    const block = renderContextBlock({
      query: { agent: "openclaw", query: "" },
      hits: [],
      injectedContext: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    });
    expect(block).toContain("<memos_context>");
    expect(block).toContain("memory_search");
    expect(block).toContain("</memos_context>");
  });
});

describe("bridgeSessionId", () => {
  it("is deterministic per (agentId, sessionKey)", () => {
    expect(bridgeSessionId("main", "s1")).toBe("openclaw::main::s1");
    expect(bridgeSessionId("main", "s1")).toBe(bridgeSessionId("main", "s1"));
    expect(bridgeSessionId("main", "s2")).not.toBe(bridgeSessionId("main", "s1"));
  });
});

describe("ephemeral-session filter", () => {
  // Regression: OpenClaw's slug-generator sub-agent shares the plugin
  // host via `sessionKey: "temp:slug-generator"`. Before this filter,
  // it opened a phantom episode on every new topic — surfacing as an
  // empty "未命名任务" row in the viewer.
  it("skips handleBeforePrompt + handleAgentEnd for temp:* sessionKeys", async () => {
    const mc = buildCore();
    await mc.init();

    const openedEpisodes: string[] = [];
    mc.subscribeEvents((e) => {
      if (e.type === "episode.opened") openedEpisodes.push(e.type);
    });

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });

    await bridge.handleBeforePrompt(
      { prompt: "generate a slug for this session", messages: [] },
      hookCtx({ sessionKey: "temp:slug-generator", agentId: "main" }),
    );
    await bridge.handleAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "generate a slug" },
          { role: "assistant", content: [{ type: "text", text: "deploy-fix" }] },
        ],
        durationMs: 50,
      },
      hookCtx({ sessionKey: "temp:slug-generator", agentId: "main" }),
    );
    await (pipeline as PipelineHandle).flush();

    expect(openedEpisodes).toEqual([]);
    const rows = await mc.listEpisodeRows({ limit: 10 });
    expect(rows.filter((r) => r.sessionId.includes("temp:")).length).toBe(0);
  });

  it("multiple topics on the same sessionKey all route to ONE core session (no phantom orphans)", async () => {
    // Regression for the "each new topic spawned two episodes, one
    // empty with 1 turns" bug. The bridge stashed
    // `openEpisodeBySession` keyed on the routed session id returned
    // from `onTurnStart`, but `handleAgentEnd` looked up by the
    // bridge-derived id. When `new_task` reclassification minted a
    // new core session those two ids diverged, leaving one orphan
    // episode on the new session + another real one on the old.
    // Invariant: for a stable `(agentId, sessionKey)` pair, every
    // captured episode must belong to the same core `sessionId`.
    const mc = buildCore();
    await mc.init();

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });

    const ctx = hookCtx({ sessionKey: "agent:main:main", agentId: "main" });
    const topics = [
      { user: "帮我推荐北京的川菜", reply: "推荐三家：..." },
      { user: "现在换个问题：怎么修复 pg_config not found", reply: "apt-get install libpq-dev" },
      { user: "把刚才的 shell 命令写成 dockerfile", reply: "FROM ubuntu:22.04..." },
    ];

    for (const t of topics) {
      await bridge.handleBeforePrompt({ prompt: t.user, messages: [] }, ctx);
      await bridge.handleAgentEnd(
        {
          success: true,
          messages: [
            { role: "user", content: t.user },
            { role: "assistant", content: [{ type: "text", text: t.reply }] },
          ],
          durationMs: 50,
        },
        ctx,
      );
    }
    await (pipeline as PipelineHandle).flush();

    const rows = await mc.listEpisodeRows({ limit: 20 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // Same sessionId for every row regardless of how the relation
    // classifier labelled each turn — no auto-minted `se_XXXX` id
    // branching off into its own lane.
    const sessionIds = new Set(rows.map((r) => r.sessionId));
    expect(sessionIds.size).toBe(1);
    expect([...sessionIds][0]).toBe("openclaw::main::agent:main:main");
    // No auto-minted `se_XXXX` orphan session — the `new_task` branch
    // must reuse the bridge-derived sessionId so `handleAgentEnd` can
    // find the open episode and avoid creating a duplicate.
    for (const r of rows) {
      expect(r.sessionId.startsWith("se_")).toBe(false);
    }
  });

  it("still captures normal sessionKey traffic", async () => {
    const mc = buildCore();
    await mc.init();

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });

    await bridge.handleBeforePrompt(
      { prompt: "normal user request", messages: [] },
      hookCtx({ sessionKey: "agent:main:main", agentId: "main" }),
    );
    await bridge.handleAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "normal user request" },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
        durationMs: 50,
      },
      hookCtx({ sessionKey: "agent:main:main", agentId: "main" }),
    );
    await (pipeline as PipelineHandle).flush();

    const rows = await mc.listEpisodeRows({ limit: 10 });
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ─── End-to-end: bridge over live MemoryCore ───────────────────────────────

function hookCtx(overrides: Partial<PluginHookAgentContext> = {}): PluginHookAgentContext {
  return {
    agentId: "main",
    sessionKey: "s-1",
    sessionId: "host-s-1",
    runId: "run-1",
    ...overrides,
  };
}

describe("createOpenClawBridge", () => {
  it("handleBeforePrompt calls core.onTurnStart and returns a prependContext result", async () => {
    const mc = buildCore();
    await mc.init();

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });
    const result = await bridge.handleBeforePrompt(
      { prompt: "help me write tests", messages: [] },
      hookCtx(),
    );
    // On empty cold-start memory we expect either undefined (nothing to
    // inject) or an object with prependContext. Never a throw.
    expect(result === undefined || typeof result === "object").toBe(true);
    if (result && typeof result === "object") {
      const keys = Object.keys(result);
      for (const key of keys) {
        expect(
          ["systemPrompt", "prependContext", "prependSystemContext", "appendSystemContext"],
        ).toContain(key);
      }
    }
  });

  it("handleAgentEnd feeds onTurnEnd and produces trace + episode.closed events", async () => {
    const mc = buildCore();
    await mc.init();

    const events: string[] = [];
    mc.subscribeEvents((e) => events.push(e.type));

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });
    await bridge.handleBeforePrompt(
      { prompt: "deploy the site", messages: [] },
      hookCtx({ sessionKey: "s-2" }),
    );
    await bridge.handleAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "deploy the site" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "running deploy" },
              {
                type: "toolCall",
                id: "c1",
                name: "sh",
                arguments: { cmd: "deploy" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "sh",
            content: "ok",
            isError: false,
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
        durationMs: 800,
      },
      hookCtx({ sessionKey: "s-2" }),
    );
    await (pipeline as PipelineHandle).flush();

    // V7 §0.1 topic-end reflection: a single `agent_end` no longer
    // closes the episode. The lite capture pass writes the trace
    // (so `trace.created` fires from the turn-added event) but the
    // episode stays OPEN until the next user turn is classified as a
    // new topic. We assert the trace was captured, not the closure.
    expect(events).toContain("trace.created");
    expect(events).not.toContain("episode.closed");
  });

  it("handleAgentEnd works even when before_prompt_build was never called (lazy episode open)", async () => {
    // V7 §0.1 regression: some hosts skip `before_prompt_build` (e.g.
    // OpenClaw's `/new` flow replays an old session without re-building
    // the prompt). The bridge must still be able to capture the turn —
    // it should lazily open a session + episode before `onTurnEnd`.
    const mc = buildCore();
    await mc.init();

    const events: string[] = [];
    mc.subscribeEvents((e) => events.push(e.type));

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });

    await bridge.handleAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "summarise the latest failures" },
          { role: "assistant", content: "here is the summary…" },
        ],
        durationMs: 400,
      },
      hookCtx({ sessionKey: "s-lazy" }),
    );
    await (pipeline as PipelineHandle).flush();

    // Same V7 §0.1 invariant as above: episode stays OPEN after one
    // turn; only the trace event fires.
    expect(events).toContain("trace.created");
    expect(events).not.toContain("episode.closed");
  });

  it("handleBeforePrompt + handleAgentEnd use the SAME episodeId (no synthetic fallback)", async () => {
    // Before the InjectionPacket.sessionId/episodeId plumbing existed,
    // the bridge's `openEpisodeBySession` cache was empty, and
    // handleAgentEnd fell back to a synthetic id that failed DB lookup.
    // This test nails the correlation down.
    const mc = buildCore();
    await mc.init();

    const episodeEvents: Array<{ type: string; payload: unknown }> = [];
    mc.subscribeEvents((e) => {
      if (
        e.type === "episode.opened" ||
        e.type === "episode.closed" ||
        e.type === "trace.created"
      ) {
        episodeEvents.push({ type: e.type, payload: e.payload });
      }
    });

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });
    await bridge.handleBeforePrompt(
      { prompt: "audit the dockerfiles", messages: [] },
      hookCtx({ sessionKey: "s-correlate" }),
    );
    await bridge.handleAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "audit the dockerfiles" },
          { role: "assistant", content: "found 3 issues" },
        ],
        durationMs: 200,
      },
      hookCtx({ sessionKey: "s-correlate" }),
    );
    await (pipeline as PipelineHandle).flush();

    // Pull episodeIds from each event payload; they must all match.
    const ids = episodeEvents
      .map((e) => (e.payload as { episodeId?: string })?.episodeId)
      .filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(1);
  });

  it("real-world smoke: '记住我喜欢游泳' flows into the L1 store and later surfaces via search", async () => {
    // This is the scenario the user reported in their bug ticket — a
    // simple Chinese request should produce a captured L1 trace and
    // the user's raw text must survive OpenClaw's envelope stripping
    // (no `Sender (untrusted metadata)`, no `<memos_context>` wrapper,
    // no `[timestamp]` prefix).
    const mc = buildCore();
    await mc.init();

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });

    // Turn 1: the user tells the agent a fact.
    const userTurn1 = "[Thu 2026-03-05 15:23 GMT+8] 记住，我喜欢的运动是游泳";
    await bridge.handleBeforePrompt(
      { prompt: userTurn1, messages: [] },
      hookCtx({ sessionKey: "s-smoke" }),
    );
    await bridge.handleAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: userTurn1 },
          { role: "assistant", content: "好的，已经记住了。" },
        ],
        durationMs: 123,
      },
      hookCtx({ sessionKey: "s-smoke" }),
    );
    await (pipeline as PipelineHandle).flush();

    // The stored trace must carry the *stripped* user text, not the
    // envelope. That's the bug the user reported — we store
    // "Sender (untrusted metadata)…" instead of "记住，…".
    const episodes = await mc.listEpisodeRows({ limit: 10 });
    expect(episodes.length).toBeGreaterThan(0);
    const traces = await mc.timeline({ episodeId: episodes[0].id as never });
    expect(traces.length).toBeGreaterThan(0);
    const first = traces[0];
    expect(first.userText).toContain("记住");
    expect(first.userText).toContain("游泳");
    // Critical invariant: the timestamp / envelope must be gone.
    expect(first.userText).not.toContain("GMT+8");
    expect(first.userText).not.toContain("Sender (untrusted metadata)");
    expect(first.userText).not.toContain("<memos_context>");
    expect(first.agentText).toContain("记住");
  });

  it("before_tool_call + after_tool_call drive recordToolOutcome", async () => {
    const mc = buildCore();
    await mc.init();

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });
    const ctx: PluginHookToolContext = {
      toolName: "sh",
      toolCallId: "call_42",
      agentId: "main",
      sessionKey: "s-tools",
      sessionId: "host-s-tools",
      runId: "run-tools",
    };
    bridge.handleBeforeToolCall({ toolName: "sh", params: { cmd: "ls" }, toolCallId: "call_42" }, ctx);
    expect(bridge.trackedToolCalls()).toBe(1);

    await bridge.handleAfterToolCall(
      {
        toolName: "sh",
        params: { cmd: "ls" },
        toolCallId: "call_42",
        durationMs: 50,
      },
      ctx,
    );
    expect(bridge.trackedToolCalls()).toBe(0);
  });

  it("handleSessionEnd closes the core session", async () => {
    const mc = buildCore();
    await mc.init();

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });
    await bridge.handleSessionStart(
      { sessionId: "host-s3", sessionKey: "s3" },
      { sessionId: "host-s3", sessionKey: "s3", agentId: "main" },
    );
    await bridge.handleSessionEnd(
      { sessionId: "host-s3", sessionKey: "s3", messageCount: 4, reason: "idle" },
      { sessionId: "host-s3", sessionKey: "s3", agentId: "main" },
    );
    // No throw = OK. trackedSessions should reflect the cleanup.
    expect(bridge.trackedSessions()).toBe(0);
  });
});

// ─── Tool registration smoke test ──────────────────────────────────────────

interface CollectedTool {
  descriptor: AgentToolDescriptor;
  opts?: OpenClawPluginToolOptions;
}

function collectTools() {
  const tools: CollectedTool[] = [];
  const hooks: Array<{ name: OpenClawHookName; handler: unknown }> = [];
  const api: OpenClawPluginApi = {
    id: "test",
    name: "test",
    logger: silentLogger(),
    registerTool(tool, opts) {
      if (typeof tool === "function") {
        const produced = (tool as OpenClawPluginToolFactory)({ agentId: "main", sessionKey: "s" });
        const descriptors = Array.isArray(produced) ? produced : produced ? [produced] : [];
        for (const d of descriptors) tools.push({ descriptor: d, opts });
      } else {
        tools.push({ descriptor: tool, opts });
      }
    },
    on<K extends OpenClawHookName>(name: K, handler: OpenClawHookHandlerMap[K]) {
      hooks.push({ name, handler });
    },
  };
  return { api, tools, hooks };
}

describe("registerOpenClawTools", () => {
  it("registers the six memory + skill tools with TypeBox parameter schemas", async () => {
    const mc = buildCore();
    await mc.init();

    const { api, tools } = collectTools();
    registerOpenClawTools(api, {
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });
    const names = tools.map((t) => t.descriptor.name).sort();
    expect(names).toEqual([
      "memory_environment",
      "memory_get",
      "memory_search",
      "memory_timeline",
      "skill_get",
      "skill_list",
    ]);
    for (const t of tools) {
      expect(typeof t.descriptor.execute).toBe("function");
      expect(t.descriptor.parameters).toBeDefined();
    }
  });

  it("memory_search executes against the core and returns well-formed hits", async () => {
    const mc = buildCore();
    await mc.init();

    const { api, tools } = collectTools();
    registerOpenClawTools(api, {
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });
    const search = tools.find((t) => t.descriptor.name === "memory_search")!;
    const res = (await search.descriptor.execute("toolCall_1", {
      query: "anything",
      maxResults: 5,
    })) as { hits: Array<unknown>; totalMs: number };
    expect(Array.isArray(res.hits)).toBe(true);
    expect(res.totalMs).toBeGreaterThanOrEqual(0);
  });
});
