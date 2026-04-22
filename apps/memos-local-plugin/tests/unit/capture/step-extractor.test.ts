import { beforeAll, describe, expect, it } from "vitest";

import { extractSteps } from "../../../core/capture/step-extractor.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type { EpisodeSnapshot, EpisodeTurn } from "../../../core/session/types.js";
import { retrievalFor } from "../../../core/session/heuristics.js";

function turn(
  role: EpisodeTurn["role"],
  content: string,
  ts: number,
  meta: Record<string, unknown> = {},
): EpisodeTurn {
  return { id: `t_${ts}`, role, content, ts, meta };
}

function episode(turns: EpisodeTurn[], metaOverride: Record<string, unknown> = {}): EpisodeSnapshot {
  return {
    id: "ep_1",
    sessionId: "se_1",
    startedAt: turns[0]?.ts ?? 1_000,
    endedAt: turns[turns.length - 1]?.ts ?? null,
    status: "closed",
    rTask: null,
    turnCount: turns.length,
    turns,
    traceIds: [],
    meta: metaOverride,
    intent: {
      kind: "task",
      confidence: 1,
      reason: "t",
      retrieval: retrievalFor("task"),
      signals: [],
    },
  };
}

describe("capture/step-extractor", () => {
  beforeAll(() => initTestLogger());

  it("single user → assistant → one step", () => {
    const ep = episode([
      turn("user", "write the readme", 1_000),
      turn("assistant", "here's the readme", 1_100),
    ]);
    const steps = extractSteps(ep);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.userText).toBe("write the readme");
    expect(steps[0]!.agentText).toBe("here's the readme");
    expect(steps[0]!.toolCalls).toEqual([]);
    expect(steps[0]!.ts).toBe(1_100);
  });

  it("assistant + tool + assistant → one step with merged tool call", () => {
    const ep = episode([
      turn("user", "ls", 1_000),
      turn("assistant", "running ls", 1_050),
      turn(
        "tool",
        "/a\n/b\n",
        1_060,
        { tool: "shell", input: { cmd: "ls" }, startedAt: 1_055, endedAt: 1_060 },
      ),
      turn("assistant", "done", 1_070),
    ]);
    const steps = extractSteps(ep);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.agentText).toBe("running ls\n\ndone");
    expect(steps[0]!.toolCalls).toHaveLength(1);
    expect(steps[0]!.toolCalls[0]!.name).toBe("shell");
    expect(steps[0]!.toolCalls[0]!.output).toBe("/a\n/b\n");
    expect(steps[0]!.toolCalls[0]!.input).toEqual({ cmd: "ls" });
    expect(steps[0]!.ts).toBe(1_070);
  });

  it("two user turns split into two steps", () => {
    const ep = episode([
      turn("user", "first", 1_000),
      turn("assistant", "a1", 1_010),
      turn("user", "second", 1_020),
      turn("assistant", "a2", 1_030),
    ]);
    const steps = extractSteps(ep);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.userText).toBe("first");
    expect(steps[0]!.agentText).toBe("a1");
    expect(steps[1]!.userText).toBe("second");
    expect(steps[1]!.agentText).toBe("a2");
  });

  it("trailing user without assistant is dropped (incomplete)", () => {
    const ep = episode([
      turn("user", "first", 1_000),
      turn("assistant", "a1", 1_010),
      turn("user", "second", 1_020), // never got a reply
    ]);
    const steps = extractSteps(ep);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.agentText).toBe("a1");
  });

  it("propagates reflection from assistant turn meta", () => {
    const ep = episode([
      turn("user", "do x", 1_000),
      turn("assistant", "done", 1_010, { reflection: "I chose X because Y." }),
    ]);
    const steps = extractSteps(ep);
    expect(steps[0]!.rawReflection).toBe("I chose X because Y.");
  });

  it("sub-agent depth propagated from meta", () => {
    const ep = episode(
      [turn("user", "q", 1_000), turn("assistant", "a", 1_010, { depth: 2, isSubagent: true })],
      {},
    );
    const steps = extractSteps(ep);
    expect(steps[0]!.depth).toBe(2);
    expect(steps[0]!.isSubagent).toBe(true);
  });

  it("synthetic fallback when no assistant turn exists", () => {
    const ep = episode([turn("user", "only me", 1_000)]);
    const steps = extractSteps(ep);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.agentText).toBe("");
    expect(steps[0]!.meta.synthetic).toBe(true);
    expect(steps[0]!.ts).toBe(1_000);
  });

  it("empty episode → zero steps", () => {
    const ep = episode([]);
    expect(extractSteps(ep)).toEqual([]);
  });

  it("skips system turns silently", () => {
    const ep = episode([
      turn("user", "hi", 1_000),
      turn("system", "tools: [shell]", 1_005),
      turn("assistant", "ok", 1_010),
    ]);
    const steps = extractSteps(ep);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.userText).toBe("hi");
  });
});
