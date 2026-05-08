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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    namespace: { agentKind: "openclaw", profileId: "main" },
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

  it("does NOT double-emit tool calls when content[] and top-level tool_calls coexist (pi-ai + OpenAI bundle)", () => {
    // Regression for the "tool call rows duplicated 2x" bug. OpenAI
    // messages plumbed through pi-ai carry the canonical pi-ai
    // `content[{type:"toolCall"}]` shape AND the legacy OpenAI
    // `tool_calls` top-level array. Pre-fix, flattenMessages emitted
    // BOTH, which made extractTurn's `pendingCalls.set(key, …)`
    // overwrite the first stub (with its `thinkingBefore`) with an
    // empty second stub — so `thinkingBefore` silently went missing
    // AND the trace ended up with 2× rows per tool.
    const flat = flattenMessages([
      { role: "user", content: "deploy" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          { type: "toolCall", id: "call_X", name: "sh", arguments: { cmd: "deploy" } },
        ],
        tool_calls: [
          {
            id: "call_X",
            function: { name: "sh", arguments: JSON.stringify({ cmd: "deploy" }) },
          },
        ],
      },
    ]);
    const toolCallEntries = flat.filter((m) => m.role === "tool_call");
    expect(toolCallEntries).toHaveLength(1);
    expect(toolCallEntries[0].toolName).toBe("sh");
    expect(toolCallEntries[0].toolCallId).toBe("call_X");
    // Ensure the assistant text emitted for the SAME message is
    // preserved — it's the `thinkingBefore` source for this call.
    const assistantText = flat.find((m) => m.role === "assistant");
    expect(assistantText?.content).toBe("running");
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
    expect(turn!.agentText).toBe("2 files");
    expect(turn!.toolCalls).toHaveLength(1);
    expect(turn!.toolCalls[0].name).toBe("sh");
    expect(turn!.toolCalls[0].input).toEqual({ cmd: "ls" });
    expect(turn!.toolCalls[0].output).toContain("a.txt");
    expect(turn!.toolCalls[0].thinkingBefore).toBe("running ls");
  });

  it("captures sysctl-style exec invocation: tool stdout lands in tool output, NOT in userText", () => {
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
    // "I'll check the system." is the model's pre-tool reasoning and
    // is captured in the tool's thinkingBefore. The final reply after
    // the tool result is agentText.
    expect(turn!.toolCalls[0].thinkingBefore).toBe("I'll check the system.");
    expect(turn!.agentText).toBe("10 核 / 16 GB");
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

  it("assigns interleaved thinking to each tool call's thinkingBefore", () => {
    // OpenClaw's PI agent alternates: think → tool → result → think → tool.
    // Both thinking blocks and regular text before a tool call are
    // captured in thinkingBefore.
    const flat = flattenMessages([
      { role: "user", content: "fix the build" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me check the error log first." },
          { type: "text", text: "checking" },
          { type: "toolCall", id: "c1", name: "sh", arguments: { cmd: "cat error.log" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "sh",
        content: "pg_config not found",
        isError: false,
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "The error says pg_config is missing. I need to install libpq-dev.",
          },
          { type: "toolCall", id: "c2", name: "sh", arguments: { cmd: "apt-get install libpq-dev" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "sh",
        content: "ok",
        isError: false,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Good, now let me retry the build." },
          { type: "toolCall", id: "c3", name: "sh", arguments: { cmd: "make build" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c3",
        toolName: "sh",
        content: "BUILD SUCCESSFUL",
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Fixed — the build passes now." }],
      },
    ]);
    const turn = extractTurn(flat, 0);
    expect(turn).not.toBeNull();
    expect(turn!.toolCalls).toHaveLength(3);
    // First tool: thinking + text merged into thinkingBefore
    expect(turn!.toolCalls[0].thinkingBefore).toBe(
      "Let me check the error log first.\n\nchecking",
    );
    expect(turn!.toolCalls[1].thinkingBefore).toBe(
      "The error says pg_config is missing. I need to install libpq-dev.",
    );
    expect(turn!.toolCalls[2].thinkingBefore).toBe("Good, now let me retry the build.");
    // All thinking was flushed into tool calls; none left over
    expect(turn!.agentThinking).toBeUndefined();
    expect(turn!.agentText).toBe("Fixed — the build passes now.");
  });

  it("tool call has no thinkingBefore when model goes directly to the tool", () => {
    const flat = flattenMessages([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "sh", arguments: { cmd: "ls" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "sh",
        content: "a.txt",
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "found a.txt" }],
      },
    ]);
    const turn = extractTurn(flat, 0);
    expect(turn!.toolCalls[0].thinkingBefore).toBeUndefined();
    expect(turn!.agentText).toBe("found a.txt");
  });

  it("captures regular assistant text between tool calls as thinkingBefore (most models)", () => {
    // Most models (non-Claude, or Claude without extended thinking)
    // produce regular text between tool calls, not ThinkingContent.
    // This text is the model's reasoning and must be captured.
    const flat = flattenMessages([
      { role: "user", content: "帮我查下当前系统有几个cpu有多少g内存" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check the CPU count first." },
          { type: "toolCall", id: "c1", name: "exec", arguments: { command: "sysctl -n hw.ncpu" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "exec",
        content: "10",
        isError: false,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "OK, 10 CPUs. Now let me check the memory." },
          { type: "toolCall", id: "c2", name: "exec", arguments: { command: "sysctl -n hw.memsize" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "exec",
        content: "17179869184",
        isError: false,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Now let me check disk space." },
          { type: "toolCall", id: "c3", name: "exec", arguments: { command: "df -h /" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c3",
        toolName: "exec",
        content: "/dev/disk1s1 466Gi 200Gi 266Gi 43% /",
        isError: false,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Your system has 10 CPUs, 16 GB RAM, and 266 GB free disk space." },
        ],
      },
    ]);
    const turn = extractTurn(flat, 0);
    expect(turn).not.toBeNull();
    expect(turn!.toolCalls).toHaveLength(3);
    expect(turn!.toolCalls[0].thinkingBefore).toBe("Let me check the CPU count first.");
    expect(turn!.toolCalls[1].thinkingBefore).toBe("OK, 10 CPUs. Now let me check the memory.");
    expect(turn!.toolCalls[2].thinkingBefore).toBe("Now let me check disk space.");
    expect(turn!.agentText).toBe(
      "Your system has 10 CPUs, 16 GB RAM, and 266 GB free disk space.",
    );
    // No thinking blocks used, so agentThinking is empty
    expect(turn!.agentThinking).toBeUndefined();
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

/**
 * V7 — OpenClaw side-channel "user" injections (heartbeat, async exec
 * completion, cron, system events, current-time footer) are NOT user
 * input. They must drop out of capture entirely so the Memories panel
 * doesn't fill up with phantom "未命名任务" rows whose userText is
 * actually `"An async command you ran earlier has completed…"` /
 * `"System (untrusted): [ts] Exec completed…"` / etc.
 *
 * These tests mirror the literal strings OpenClaw emits in
 * `infra/heartbeat-events-filter.ts` + `auto-reply/reply/session-system-events.ts`.
 * If you change one, change the other in lockstep.
 */
describe("OpenClaw side-channel user injections", () => {
  it("drops the async-exec-completion wakeup prompt as bootstrap (no captured turn)", () => {
    const flat = flattenMessages([
      {
        role: "user",
        content:
          "An async command you ran earlier has completed. The result is shown in the system messages above. " +
          "Handle the result internally. Do not relay it to the user unless explicitly requested.\n" +
          "Current time: Thursday, April 23rd, 2026 - 10:45 AM (Asia/Shanghai)",
      },
      { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    ]);
    const turn = extractTurn(flat, 0);
    // After the line-level stripper removes "Current time: …" the
    // remaining text starts with "An async command…", which the
    // bootstrap detector recognises and the bridge's handleAgentEnd
    // skips. extractTurn returns userText that *contains* the
    // signature; the bridge then calls isOpenClawBootstrapMessage on
    // it and bails. We assert that string surface here.
    expect(turn?.userText.startsWith("An async command you ran earlier has completed")).toBe(true);
  });

  it("drops the cron heartbeat wakeup prompt as bootstrap", () => {
    const flat = flattenMessages([
      {
        role: "user",
        content:
          "A scheduled reminder has been triggered. The reminder content is:\n\n" +
          "[cron:abc] do the thing\n\n" +
          "Please relay this reminder to the user in a helpful and friendly way.",
      },
    ]);
    const turn = extractTurn(flat, 0);
    expect(turn?.userText.startsWith("A scheduled reminder has been triggered")).toBe(true);
  });

  it("drops the heartbeat periodic-tasks wakeup prompt as bootstrap", () => {
    const flat = flattenMessages([
      {
        role: "user",
        content:
          "Run the following periodic tasks (only those due based on their intervals):\n\n" +
          "- summary: write a daily summary\n\n" +
          "After completing all due tasks, reply HEARTBEAT_OK.",
      },
    ]);
    const turn = extractTurn(flat, 0);
    expect(turn?.userText.startsWith("Run the following periodic tasks")).toBe(true);
  });

  it("strips System (untrusted) lines + Current time footer when wrapping a bootstrap prompt", () => {
    // Pure system-event payload — every line is a side-channel
    // injection. After stripping the user text is empty; the bridge's
    // `if (!turn.userText)` guard then skips the whole turn.
    const flat = flattenMessages([
      {
        role: "user",
        content:
          "System (untrusted): [2026-04-23 10:44:37 GMT+8] Exec completed (wild-kel, code 0) :: pkg-1 pkg-2 pkg-3\n" +
          "System (untrusted): [2026-04-23 10:44:38 GMT+8] Exec completed (wild-kel, code 0) :: more-output\n" +
          "Current time: Thursday, April 23rd, 2026 - 10:45 AM (Asia/Shanghai) / 2026-04-23 02:45 UTC",
      },
    ]);
    const turn = extractTurn(flat, 0);
    expect(turn?.userText).toBe("");
  });

  it("preserves the real user query when System (untrusted) lines are layered on top", () => {
    // Real user said "帮我查 cpu"; OpenClaw prepended a stale exec
    // completion event and appended a Current time footer. The
    // stripper must drop the noise but keep the actual query intact.
    const flat = flattenMessages([
      {
        role: "user",
        content:
          "System (untrusted): [2026-04-23 10:44:37 GMT+8] Exec completed (foo, code 0) :: build done\n" +
          "\n" +
          "帮我查下当前系统有几个 cpu\n" +
          "Current time: Thursday, April 23rd, 2026 - 10:45 AM (Asia/Shanghai)",
      },
      { role: "assistant", content: [{ type: "text", text: "好的，我来查一下" }] },
    ]);
    const turn = extractTurn(flat, 0);
    expect(turn?.userText).toBe("帮我查下当前系统有几个 cpu");
    expect(turn?.agentText).toBe("好的，我来查一下");
  });

  it("strips the standalone HEARTBEAT.md workspace hint to empty (caught by bridge's empty-text guard)", () => {
    const flat = flattenMessages([
      {
        role: "user",
        content:
          "When reading HEARTBEAT.md, use workspace file /Users/jiang/proj/HEARTBEAT.md (exact case). " +
          "Do not read docs/heartbeat.md.",
      },
    ]);
    const turn = extractTurn(flat, 0);
    // Line-level stripper drops the whole line. handleAgentEnd's
    // `if (!turn.userText) return;` then short-circuits.
    expect(turn?.userText).toBe("");
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

  it("does not let a delayed agent_end clear the next turn's episode binding", async () => {
    // OpenClaw hooks can overlap: the next before_prompt_build may route
    // a fresh episode before the previous agent_end finishes. The bridge
    // must clear only the binding that belongs to the ending run, or the
    // next agent_end will fall back to openEpisode() and leave an empty
    // phantom task in the viewer.
    const mc = buildCore();
    await mc.init();

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });
    const sessionKey = "s-overlap";
    const firstCtx = hookCtx({ sessionKey, runId: "run-overlap-1" });
    const secondCtx = hookCtx({ sessionKey, runId: "run-overlap-2" });

    await bridge.handleBeforePrompt(
      { prompt: "北京市市委书记是谁", messages: [] },
      firstCtx,
    );
    await bridge.handleBeforePrompt(
      { prompt: "可以只访问国内的网站", messages: [] },
      secondCtx,
    );

    await bridge.handleAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "北京市市委书记是谁" },
          { role: "assistant", content: "北京市市委书记是尹力。" },
        ],
      },
      firstCtx,
    );
    await bridge.handleAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "北京市市委书记是谁" },
          { role: "assistant", content: "北京市市委书记是尹力。" },
          { role: "user", content: "可以只访问国内的网站" },
          { role: "assistant", content: "好的，我会优先访问国内网站确认。" },
        ],
      },
      secondCtx,
    );
    await (pipeline as PipelineHandle).flush();

    const rows = await mc.listEpisodeRows({
      sessionId: bridgeSessionId("main", sessionKey),
      limit: 10,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.turnCount > 0 || row.hasAssistantReply)).toBe(true);
    expect(
      rows.filter((row) =>
        row.preview === "可以只访问国内的网站" && !row.hasAssistantReply
      ),
    ).toHaveLength(0);
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

  it("subagent_ended does not create a synthetic parent task", async () => {
    const mc = buildCore();
    await mc.init();

    const recordSubagentOutcome = vi.fn(mc.recordSubagentOutcome.bind(mc));
    (mc as any).recordSubagentOutcome = recordSubagentOutcome;

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });

    expect(typeof (bridge as any).handleSubagentEnded).toBe("function");
    await (bridge as any).handleSubagentEnded(
      {
        targetSessionKey: "child-session",
        targetKind: "subagent",
        reason: "completed",
        runId: "run-sub-1",
        outcome: "ok",
      },
      {
        agentId: "main",
        sessionKey: "parent-session",
        sessionId: "host-parent",
        runId: "run-parent",
      },
    );

    expect(recordSubagentOutcome).not.toHaveBeenCalled();
    await expect(mc.listEpisodeRows({ limit: 10 })).resolves.toHaveLength(0);
  });

  it("merges subagent auto-announce into the parent episode", async () => {
    const mc = buildCore();
    await mc.init();

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });
    const ctx: PluginHookAgentContext = {
      agentId: "main",
      sessionKey: "agent:main:explicit:subagent-parent",
      sessionId: "host-parent",
      runId: "run-parent",
      workspaceDir: "/tmp/workspace",
    };
    const parentSessionId = bridgeSessionId("main", ctx.sessionKey!);

    await bridge.handleBeforePrompt(
      {
        prompt: "请派一个子代理检查 package.json scripts，然后主代理总结结果。",
        messages: [],
      },
      ctx,
    );
    bridge.handleSubagentSpawned(
      {
        runId: "run-sub",
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        mode: "run",
        label: "检查 package.json scripts",
      },
      {
        ...ctx,
        requesterSessionKey: ctx.sessionKey,
        childSessionKey: "agent:main:subagent:child",
      },
    );
    await bridge.handleAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "请派一个子代理检查 package.json scripts，然后主代理总结结果。" },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-spawn",
                name: "sessions_spawn",
                arguments: {
                  mode: "run",
                  runtime: "subagent",
                  task: "检查 package.json scripts",
                },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call-spawn",
            toolName: "sessions_spawn",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "accepted",
                  childSessionKey: "agent:main:subagent:child",
                  runId: "run-sub",
                }),
              },
            ],
          },
          { role: "assistant", content: "子代理已派出，等待完成后我会总结。" },
        ],
      },
      ctx,
    );

    const announcementPrompt = [
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "A completed subagent task is ready for user delivery.",
      "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
      "当前目录没有 package.json。",
      "<<<END_UNTRUSTED_CHILD_RESULT>>>",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");
    await expect(
      bridge.handleBeforePrompt({ prompt: announcementPrompt, messages: [] }, ctx),
    ).resolves.toBeUndefined();
    await bridge.handleAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: announcementPrompt },
          { role: "assistant", content: "子代理检查完成：当前目录没有 package.json。" },
        ],
      },
      ctx,
    );

    const episodes = await mc.listEpisodeRows({ sessionId: parentSessionId, limit: 10 });
    expect(episodes).toHaveLength(1);
    const traces = await mc.timeline({ episodeId: episodes[0]!.id as never });
    expect(traces.some((tr) => tr.agentText.includes("子代理已派出"))).toBe(true);
    expect(traces.some((tr) => tr.userText.includes("BEGIN_OPENCLAW_INTERNAL_CONTEXT"))).toBe(false);
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
    })) as {
      hits: Array<unknown>;
      totalMs: number;
      content: Array<{ type: "text"; text: string }>;
      details: { hits: Array<unknown>; totalMs: number };
    };
    expect(Array.isArray(res.hits)).toBe(true);
    expect(res.totalMs).toBeGreaterThanOrEqual(0);
    // Latest OpenClaw's MCP plugin-tools bridge serializes only
    // `result.content`; keep that populated while preserving the older
    // top-level object shape used by local tests and callers.
    expect(res.content[0]?.type).toBe("text");
    expect(res.content[0]?.text).toContain("memories");
    expect(res.details.hits).toBe(res.hits);
  });

  it("memory_search maps per-tier topK params and keeps maxResults fallback", async () => {
    const searchMemory = vi.fn(async () => ({
      hits: [],
      injectedContext: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    }));
    const mc = { searchMemory } as unknown as MemoryCore;

    const { api, tools } = collectTools();
    registerOpenClawTools(api, {
      agent: "openclaw",
      core: mc,
      log: silentLogger(),
    });
    const search = tools.find((t) => t.descriptor.name === "memory_search")!;

    await search.descriptor.execute("toolCall_1", {
      query: "anything",
      maxResults: 7,
      tier1topK: 2,
      tier3topK: 0,
    });
    expect(searchMemory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: "anything",
        topK: { tier1: 2, tier2: 7, tier3: 0 },
      }),
    );

    await search.descriptor.execute("toolCall_2", {
      query: "fallback",
      maxResults: 4,
    });
    expect(searchMemory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: "fallback",
        topK: { tier1: 4, tier2: 4, tier3: 4 },
      }),
    );
  });

  it("registers tool shells before the async core is resolved", async () => {
    const mc = buildCore();
    await mc.init();

    let requestedCore = false;
    const { api, tools } = collectTools();
    registerOpenClawTools(api, {
      agent: "openclaw",
      getCore: async () => {
        requestedCore = true;
        return mc;
      },
      log: silentLogger(),
    });

    expect(tools.map((t) => t.descriptor.name)).toContain("memory_search");
    expect(requestedCore).toBe(false);

    const search = tools.find((t) => t.descriptor.name === "memory_search")!;
    await search.descriptor.execute("toolCall_1", {
      query: "anything",
      maxResults: 5,
    });
    expect(requestedCore).toBe(true);
  });
});
