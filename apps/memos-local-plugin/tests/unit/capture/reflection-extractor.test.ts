import { describe, expect, it } from "vitest";

import { extractReflection } from "../../../core/capture/reflection-extractor.js";
import type { NormalizedStep } from "../../../core/capture/types.js";

function step(partial: Partial<NormalizedStep>): NormalizedStep {
  return {
    key: "k",
    ts: 1_000,
    userText: partial.userText ?? "",
    agentText: partial.agentText ?? "",
    toolCalls: partial.toolCalls ?? [],
    rawReflection: partial.rawReflection ?? null,
    depth: 0,
    isSubagent: false,
    meta: {},
    truncated: false,
  };
}

describe("capture/reflection-extractor", () => {
  it("prefers adapter-provided rawReflection", () => {
    const r = extractReflection(
      step({
        rawReflection: "I picked X because Y.",
        agentText: "### Reasoning:\nI picked something else",
      }),
    );
    expect(r).toBe("I picked X because Y.");
  });

  it("extracts markdown ### Reasoning block", () => {
    const r = extractReflection(
      step({
        agentText:
          "Sure, here's the fix.\n\n### Reasoning:\nThe bug was in the null check because the cache was cold.\n\n### Result:\nAll green.",
      }),
    );
    expect(r).toContain("The bug was in the null check");
    expect(r).not.toContain("Result");
  });

  it("extracts <reflection>...</reflection> legacy tags", () => {
    const r = extractReflection(
      step({
        agentText:
          "Run passed.\n<reflection>I retried the request once, then gave up to avoid an infinite loop.</reflection>",
      }),
    );
    expect(r).toContain("retried the request once");
  });

  it("extracts inline 'Reflection:' phrase", () => {
    const r = extractReflection(
      step({
        agentText:
          "Final answer is 42.\n\nReflection: I chose 42 because it's the right length for the docstring. This approach keeps the function small.",
      }),
    );
    expect(r?.length).toBeGreaterThanOrEqual(20);
    expect(r).toContain("docstring");
  });

  it("extracts Chinese 思考过程", () => {
    const r = extractReflection(
      step({
        agentText: "我先运行了 ls，然后读取 log。\n\n思考过程：我觉得这个错误应该是权限问题导致的，所以先 chmod。",
      }),
    );
    expect(r).toBeTruthy();
    expect(r).toContain("权限问题");
  });

  it("returns null when no pattern matches", () => {
    const r = extractReflection(step({ agentText: "Done." }));
    expect(r).toBeNull();
  });

  it("returns null when agent text is empty and no rawReflection", () => {
    expect(extractReflection(step({ agentText: "" }))).toBeNull();
  });

  it("ignores too-short matches", () => {
    const r = extractReflection(step({ agentText: "Reflection: ok" }));
    expect(r).toBeNull();
  });

  it("caps extracted reflection at 1500 chars", () => {
    const body = "X".repeat(5_000);
    const r = extractReflection(step({ agentText: `Reasoning: ${body}` }));
    expect(r).not.toBeNull();
    expect(r!.length).toBeLessThanOrEqual(1_500);
  });
});
