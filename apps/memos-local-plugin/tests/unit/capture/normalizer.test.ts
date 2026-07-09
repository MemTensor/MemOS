import { beforeAll, describe, expect, it } from "vitest";

import { normalizeSteps } from "../../../core/capture/normalizer.js";
import type { CaptureConfig, StepCandidate } from "../../../core/capture/types.js";
import { initTestLogger } from "../../../core/logger/index.js";

const cfg: CaptureConfig = {
  maxTextChars: 1_000,
  maxToolOutputChars: 300,
  embedTraces: false,
  alphaScoring: false,
  synthReflections: false,
  llmConcurrency: 1,
  batchMode: "per_step",
  batchThreshold: 12,
};

function step(partial: Partial<StepCandidate>): StepCandidate {
  return {
    key: partial.key ?? "k",
    ts: partial.ts ?? 1_000,
    userText: partial.userText ?? "",
    agentText: partial.agentText ?? "",
    toolCalls: partial.toolCalls ?? [],
    rawReflection: partial.rawReflection ?? null,
    depth: partial.depth ?? 0,
    isSubagent: partial.isSubagent ?? false,
    meta: partial.meta ?? {},
  };
}

describe("capture/normalizer", () => {
  beforeAll(() => initTestLogger());

  it("passes short content through untouched, truncated=false", () => {
    const out = normalizeSteps([step({ userText: "hi", agentText: "hello" })], cfg);
    expect(out).toHaveLength(1);
    expect(out[0]!.truncated).toBe(false);
    expect(out[0]!.userText).toBe("hi");
    expect(out[0]!.agentText).toBe("hello");
  });

  it("truncates over-cap agent text with head+tail marker", () => {
    const head = "A".repeat(800);
    const tail = "Z".repeat(400);
    const out = normalizeSteps([step({ agentText: head + tail })], cfg);
    expect(out[0]!.truncated).toBe(true);
    expect(out[0]!.agentText.length).toBeLessThan(1_200);
    expect(out[0]!.agentText.startsWith("AAA")).toBe(true);
    expect(out[0]!.agentText.includes("[truncated]")).toBe(true);
    expect(out[0]!.agentText.endsWith("ZZZ")).toBe(true);
  });

  it("truncates over-cap tool output", () => {
    const bigOut = "X".repeat(1_000);
    const out = normalizeSteps(
      [
        step({
          userText: "q",
          agentText: "a",
          toolCalls: [
            {
              name: "shell",
              input: { cmd: "ls" },
              output: bigOut,
              startedAt: 0,
              endedAt: 1,
            },
          ],
        }),
      ],
      cfg,
    );
    expect(out[0]!.truncated).toBe(true);
    const toolOut = out[0]!.toolCalls[0]!.output as string;
    expect(toolOut.length).toBeLessThan(700);
    expect(toolOut.includes("[truncated]")).toBe(true);
  });

  it("drops step with no user, agent, or tool output", () => {
    const out = normalizeSteps([step({})], cfg);
    expect(out).toHaveLength(0);
  });

  it("dedupes adjacent identical steps", () => {
    const s1 = step({ userText: "u", agentText: "a" });
    const s2 = step({ userText: "u", agentText: "a", key: "k2" });
    const out = normalizeSteps([s1, s2], cfg);
    expect(out).toHaveLength(1);
  });

  it("keeps non-adjacent duplicates (they may indicate a retry cycle)", () => {
    const s1 = step({ userText: "u", agentText: "a" });
    const mid = step({ userText: "u2", agentText: "b" });
    const s3 = step({ userText: "u", agentText: "a", key: "k3" });
    const out = normalizeSteps([s1, mid, s3], cfg);
    expect(out).toHaveLength(3);
  });

  it("converts structured tool output to JSON string", () => {
    const out = normalizeSteps(
      [
        step({
          userText: "q",
          toolCalls: [
            { name: "x", input: {}, output: { ok: true }, startedAt: 0, endedAt: 1 },
          ],
        }),
      ],
      cfg,
    );
    expect(typeof out[0]!.toolCalls[0]!.output).toBe("string");
    expect(out[0]!.toolCalls[0]!.output).toContain("true");
  });
});
