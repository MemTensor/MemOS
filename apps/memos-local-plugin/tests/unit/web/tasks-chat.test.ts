/**
 * Unit tests for `flattenChat` — the pure function the Tasks drawer
 * uses to turn an episode timeline (a list of L1 traces) into a linear
 * chat log of `user / tool / thinking / assistant` bubbles.
 *
 * We test the function in isolation (no Preact renderer) — Preact tests
 * would need jsdom + a renderer harness this package deliberately does
 * not ship. The visual layer is exercised manually via the viewer.
 */

import { describe, it, expect } from "vitest";

import {
  flattenChat,
  type TimelineTrace,
} from "../../../web/src/views/tasks-chat-data";

const T0 = 1_700_000_000_000;

function trace(part: Partial<TimelineTrace>): TimelineTrace {
  return {
    id: part.id ?? "tr_x",
    ts: part.ts ?? T0,
    userText: part.userText ?? "",
    agentText: part.agentText ?? "",
    agentThinking: part.agentThinking ?? null,
    reflection: part.reflection ?? null,
    value: part.value ?? 0,
    toolCalls: part.toolCalls ?? [],
  };
}

describe("flattenChat", () => {
  it("emits user → tool cards with thinking → assistant; reflection is dropped", () => {
    const t = trace({
      id: "tr1",
      userText: "go fix the deploy",
      agentText: "done — see PR #42",
      reflection:
        "INTERNAL: scoring note — α should be high because this step pinpointed the root cause.",
      toolCalls: [
        {
          name: "bash",
          input: "pip install psycopg2",
          output: "Error: pg_config not found",
          startedAt: T0 + 10,
          endedAt: T0 + 200,
          errorCode: "EXIT_1",
          thinkingBefore: "Looking at the error chain, pg_config is missing.",
        },
        {
          name: "bash",
          input: "apt-get install libpq-dev",
          output: "ok",
          startedAt: T0 + 300,
          endedAt: T0 + 800,
        },
      ],
    });
    const msgs = flattenChat([t]);
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(msgs[1]!.traceId).toBe("tr1");
    expect(msgs[1]!.toolName).toBe("bash");
    expect(msgs[1]!.toolThinking).toContain("pg_config is missing");
    expect(msgs[1]!.toolThinking).not.toContain("INTERNAL: scoring note");
    expect(msgs[1]!.toolInput).toContain("pip install psycopg2");
    expect(msgs[1]!.toolOutput).toContain("pg_config not found");
    expect(msgs[1]!.errorCode).toBe("EXIT_1");
    expect(msgs[1]!.toolDurationMs).toBe(190);
    expect(msgs[3]!.text).toBe("done — see PR #42");
    for (const m of msgs) {
      expect(m.text).not.toContain("INTERNAL: scoring note");
    }
  });

  it("never emits a thinking bubble when the trace only has a reflection", () => {
    // V7 §0.1 separation regression: reflection is plugin-internal
    // scoring data and must NOT pollute the conversation log even
    // when no agentThinking is present.
    const t = trace({
      id: "tr_nothink",
      userText: "x",
      agentText: "y",
      reflection: "this should not appear in the chat log",
    });
    const msgs = flattenChat([t]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("sorts tool calls within a trace by startedAt", () => {
    const t = trace({
      id: "tr2",
      userText: "do thing",
      agentText: "ok",
      toolCalls: [
        { name: "second", startedAt: T0 + 500, endedAt: T0 + 600 },
        { name: "first", startedAt: T0 + 100, endedAt: T0 + 200 },
        { name: "third", startedAt: T0 + 800, endedAt: T0 + 900 },
      ],
    });
    const msgs = flattenChat([t]);
    const toolOrder = msgs.filter((m) => m.role === "tool").map((m) => m.toolName);
    expect(toolOrder).toEqual(["first", "second", "third"]);
  });

  it("falls back to trace.ts when a tool call has no startedAt", () => {
    const t = trace({
      id: "tr3",
      ts: T0 + 9_000,
      userText: "x",
      agentText: "y",
      toolCalls: [
        { name: "no-time" },
        { name: "early", startedAt: T0 + 1_000, endedAt: T0 + 2_000 },
      ],
    });
    const msgs = flattenChat([t]).filter((m) => m.role === "tool");
    // `early` (1000) sorts before `no-time` (which fell back to trace.ts=9000).
    expect(msgs.map((m) => m.toolName)).toEqual(["early", "no-time"]);
    // The fallback message uses the trace ts too.
    expect(msgs[1]!.ts).toBe(T0 + 9_000);
    // No duration when startedAt/endedAt are missing.
    expect(msgs[1]!.toolDurationMs).toBeUndefined();
  });

  it("skips empty user/agent/reflection slots silently", () => {
    const t = trace({
      id: "tr4",
      userText: "   ",
      agentText: "",
      reflection: "  \n",
      toolCalls: [{ name: "lonely-tool" }],
    });
    const msgs = flattenChat([t]);
    expect(msgs.map((m) => m.role)).toEqual(["tool"]);
  });

  it("serialises object tool inputs as pretty JSON, leaves strings alone", () => {
    const t = trace({
      id: "tr5",
      userText: "q",
      toolCalls: [
        {
          name: "structured",
          input: { foo: 1, bar: ["a", "b"] },
          output: { ok: true, rows: 3 },
        },
        { name: "plain", input: "raw stdin payload", output: "raw stdout payload" },
      ],
    });
    const tools = flattenChat([t]).filter((m) => m.role === "tool");
    expect(tools[0]!.toolInput).toContain('"foo": 1');
    expect(tools[0]!.toolOutput).toContain('"ok": true');
    expect(tools[1]!.toolInput).toBe("raw stdin payload");
    expect(tools[1]!.toolOutput).toBe("raw stdout payload");
  });

  it("clips oversized tool payloads instead of dropping them", () => {
    const big = "x".repeat(20_000);
    const t = trace({
      id: "tr6",
      userText: "big",
      toolCalls: [{ name: "dump", input: big, output: big }],
    });
    const tool = flattenChat([t]).find((m) => m.role === "tool")!;
    // Internal cap is well under raw size — confirm we don't ship 20K
    // chars into the chat bubble. Exact threshold is implementation
    // detail; assert "much smaller, ends with ellipsis".
    expect(tool.toolInput!.length).toBeLessThan(2_000);
    expect(tool.toolInput!.endsWith("…")).toBe(true);
    expect(tool.toolOutput!.endsWith("…")).toBe(true);
  });

  it("preserves cross-trace ordering: each trace's full block before the next", () => {
    const a = trace({
      id: "tr_a",
      ts: T0,
      userText: "step 1",
      agentText: "ok 1",
      agentThinking: "thinking 1",
    });
    const b = trace({
      id: "tr_b",
      ts: T0 + 5_000,
      userText: "step 2",
      agentText: "ok 2",
      agentThinking: "thinking 2",
    });
    const msgs = flattenChat([a, b]).map((m) => m.text);
    expect(msgs).toEqual([
      "step 1",
      "thinking 1",
      "ok 1",
      "step 2",
      "thinking 2",
      "ok 2",
    ]);
  });

  it("attaches per-tool thinking when thinkingBefore is present", () => {
    const t = trace({
      id: "tr_interleave",
      userText: "fix the build",
      agentText: "Fixed — build passes now.",
      agentThinking: "Check error log.\n\nNeed libpq-dev.\n\nRetry the build.",
      toolCalls: [
        {
          name: "sh",
          input: "cat error.log",
          output: "pg_config not found",
          startedAt: T0 + 10,
          endedAt: T0 + 200,
          thinkingBefore: "Check error log.",
        },
        {
          name: "sh",
          input: "apt-get install libpq-dev",
          output: "ok",
          startedAt: T0 + 300,
          endedAt: T0 + 800,
          thinkingBefore: "Need libpq-dev.",
        },
        {
          name: "sh",
          input: "make build",
          output: "BUILD SUCCESSFUL",
          startedAt: T0 + 900,
          endedAt: T0 + 1500,
          thinkingBefore: "Retry the build.",
        },
      ],
    });
    const msgs = flattenChat([t]);
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "tool",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(msgs[1]!.toolThinking).toBe("Check error log.");
    expect(msgs[2]!.toolThinking).toBe("Need libpq-dev.");
    expect(msgs[3]!.toolThinking).toBe("Retry the build.");
  });

  it("no thinking bubbles when tools lack thinkingBefore (agentThinking only shown for no-tool turns)", () => {
    const t = trace({
      id: "tr_no_tb",
      userText: "go",
      agentText: "done",
      agentThinking: "Some thinking.",
      toolCalls: [
        { name: "tool_a", startedAt: T0 + 10, endedAt: T0 + 100 },
        { name: "tool_b", startedAt: T0 + 200, endedAt: T0 + 300 },
      ],
    });
    const msgs = flattenChat([t]);
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "tool",
      "tool",
      "assistant",
    ]);
  });

  it("only some tools have thinkingBefore — those without get no bubble", () => {
    const t = trace({
      id: "tr_partial",
      userText: "go",
      agentText: "done",
      agentThinking: "initial\n\nsecond thought",
      toolCalls: [
        {
          name: "tool_a",
          startedAt: T0 + 10,
          endedAt: T0 + 100,
          thinkingBefore: "initial",
        },
        {
          name: "tool_b",
          startedAt: T0 + 200,
          endedAt: T0 + 300,
          // no thinkingBefore — model went straight to the next tool
        },
      ],
    });
    const msgs = flattenChat([t]);
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "tool",
      "tool",       // no thinking before tool_b
      "assistant",
    ]);
    expect(msgs[1]!.toolThinking).toBe("initial");
  });

  it("returns empty array for empty input", () => {
    expect(flattenChat([])).toEqual([]);
  });
});

// ─── parallel-batch detection ─────────────────────────────────────────────
//
// We verify the heuristic in `assignParallelBatches`:
//   - Three tools whose `startedAt` are within ~10ms of each other (typical
//     pi-agent-core parallel dispatch) → all three carry `parallelBatchKey`
//     with `parallelBatchSize === 3`.
//   - Two tools separated by a gap > 500ms (LLM round-trip) → no batch
//     metadata; each renders standalone.
//   - Mixed: a parallel pair followed by a serial single → only the pair
//     gets metadata.
//   - A single tool inside a trace → no batch metadata even if it's the
//     only tool emitted that turn.

describe("flattenChat / parallel-batch detection", () => {
  it("groups three tools dispatched within ms of each other", () => {
    const t = trace({
      id: "tr_par",
      userText: "查 cpu 内存 硬盘",
      agentText: "8 核 16G",
      toolCalls: [
        {
          name: "lscpu",
          startedAt: T0 + 1,
          endedAt: T0 + 13,
          thinkingBefore: "我同时查",
        },
        { name: "free -h", startedAt: T0 + 3, endedAt: T0 + 11 },
        { name: "df -h", startedAt: T0 + 5, endedAt: T0 + 29 },
      ],
    });
    const msgs = flattenChat([t]);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(3);
    const key = tools[0]!.parallelBatchKey;
    expect(key).toBeDefined();
    for (const m of tools) {
      expect(m.parallelBatchKey).toBe(key);
      expect(m.parallelBatchSize).toBe(3);
      // wall-clock span = max(endedAt) − min(startedAt) = 29 − 1 = 28
      expect(m.parallelBatchTotalMs).toBe(28);
    }
  });

  it("does not batch two tools separated by an LLM round-trip", () => {
    // tool_1 ends at T0+5, tool_2 starts at T0+1500 → gap 1495ms ≫ 500ms
    // threshold → these are clearly two separate LLM turns, not a batch.
    const t = trace({
      id: "tr_serial",
      userText: "ls then cat",
      agentText: "done",
      toolCalls: [
        {
          name: "ls",
          startedAt: T0 + 1,
          endedAt: T0 + 5,
          thinkingBefore: "list dir",
        },
        {
          name: "cat foo",
          startedAt: T0 + 1_500,
          endedAt: T0 + 1_510,
          thinkingBefore: "found foo, cat it",
        },
      ],
    });
    const msgs = flattenChat([t]);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]!.parallelBatchKey).toBeUndefined();
    expect(tools[1]!.parallelBatchKey).toBeUndefined();
    expect(tools[0]!.parallelBatchSize).toBeUndefined();
    expect(tools[1]!.parallelBatchSize).toBeUndefined();
  });

  it("mixes a parallel pair followed by a serial single tool", () => {
    const t = trace({
      id: "tr_mix",
      userText: "查 cpu 内存,然后看 disk",
      agentText: "ok",
      toolCalls: [
        // Parallel pair (within 10ms of each other)
        {
          name: "lscpu",
          startedAt: T0 + 1,
          endedAt: T0 + 12,
          thinkingBefore: "并查",
        },
        { name: "free", startedAt: T0 + 3, endedAt: T0 + 8 },
        // Serial single — fired after a 1s gap (LLM round-trip)
        {
          name: "df",
          startedAt: T0 + 1_200,
          endedAt: T0 + 1_240,
          thinkingBefore: "再看 disk",
        },
      ],
    });
    const msgs = flattenChat([t]);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(3);
    // First two share a batch key, size 2
    expect(tools[0]!.parallelBatchKey).toBeDefined();
    expect(tools[0]!.parallelBatchKey).toBe(tools[1]!.parallelBatchKey);
    expect(tools[0]!.parallelBatchSize).toBe(2);
    expect(tools[1]!.parallelBatchSize).toBe(2);
    // Third stands alone
    expect(tools[2]!.parallelBatchKey).toBeUndefined();
  });

  it("does not batch a single tool", () => {
    const t = trace({
      id: "tr_single",
      userText: "go",
      agentText: "done",
      toolCalls: [
        {
          name: "echo",
          startedAt: T0 + 1,
          endedAt: T0 + 5,
          thinkingBefore: "say hi",
        },
      ],
    });
    const msgs = flattenChat([t]);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.parallelBatchKey).toBeUndefined();
    expect(tools[0]!.parallelBatchSize).toBeUndefined();
  });

  it("crosses trace boundaries when sub-steps share an LLM dispatch", () => {
    // step-extractor splits one user turn into N sub-step traces (one per
    // tool). When those sub-steps came from the same parallel dispatch
    // their startedAt timestamps still cluster within ms of each other,
    // so the cross-trace heuristic must still detect the batch.
    const t1 = trace({
      id: "tr_a",
      userText: "查 cpu 内存 硬盘",
      agentText: "",
      toolCalls: [
        {
          name: "lscpu",
          startedAt: T0 + 1,
          endedAt: T0 + 12,
          thinkingBefore: "并查",
        },
      ],
    });
    const t2 = trace({
      id: "tr_b",
      userText: "",
      agentText: "",
      ts: T0 + 3,
      toolCalls: [{ name: "free", startedAt: T0 + 3, endedAt: T0 + 8 }],
    });
    const t3 = trace({
      id: "tr_c",
      userText: "",
      agentText: "8 核 16G",
      ts: T0 + 5,
      toolCalls: [{ name: "df", startedAt: T0 + 5, endedAt: T0 + 29 }],
    });
    const msgs = flattenChat([t1, t2, t3]);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(3);
    // All three share the same batch key + size 3 even though they came
    // from three different traces.
    const key = tools[0]!.parallelBatchKey;
    expect(key).toBeDefined();
    expect(tools[1]!.parallelBatchKey).toBe(key);
    expect(tools[2]!.parallelBatchKey).toBe(key);
    expect(tools[0]!.parallelBatchSize).toBe(3);
  });
});
