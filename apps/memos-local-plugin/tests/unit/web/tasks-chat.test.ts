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
  it("emits user → thinking → tools → assistant in that order; reflection is dropped", () => {
    const t = trace({
      id: "tr1",
      userText: "go fix the deploy",
      agentText: "done — see PR #42",
      // LLM-native thinking — must surface as a chat bubble.
      agentThinking: "Looking at the error chain, pg_config is missing.",
      // Plugin-internal reflection — must NEVER appear in the chat log.
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
      "thinking",
      "tool",
      "tool",
      "assistant",
    ]);
    // The thinking bubble is the model's NATIVE reasoning, NOT
    // reflection (which is the plugin's scoring scratchpad).
    expect(msgs[1]!.text).toContain("pg_config is missing");
    expect(msgs[1]!.text).not.toContain("INTERNAL: scoring note");
    // Both tools point back at the same trace and carry their full payload.
    expect(msgs[2]!.traceId).toBe("tr1");
    expect(msgs[2]!.toolName).toBe("bash");
    expect(msgs[2]!.toolInput).toContain("pip install psycopg2");
    expect(msgs[2]!.toolOutput).toContain("pg_config not found");
    expect(msgs[2]!.errorCode).toBe("EXIT_1");
    expect(msgs[2]!.toolDurationMs).toBe(190);
    // Assistant is the agent text.
    expect(msgs[4]!.text).toBe("done — see PR #42");
    // No bubble's text leaks the reflection content anywhere.
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

  it("returns empty array for empty input", () => {
    expect(flattenChat([])).toEqual([]);
  });
});
