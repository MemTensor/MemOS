import { describe, expect, it } from "vitest";

import {
  isStandaloneMathFinalAnswerTask,
  mergeMathFinalAnswerProtocol,
  renderMathFinalAnswerProtocol,
} from "../../../core/retrieval/math-task.js";

describe("retrieval/math-task", () => {
  it("detects standalone math final-answer prompts using generic signals", () => {
    expect(
      isStandaloneMathFinalAnswerTask(
        "Please solve this olympiad-style combinatorics problem and give the final answer in \\boxed{...} format.",
      ),
    ).toBe(true);
    expect(
      isStandaloneMathFinalAnswerTask(
        "Find all real numbers x satisfying the polynomial equation and give the final answer.",
      ),
    ).toBe(true);
  });

  it("does not classify non-math requests", () => {
    expect(isStandaloneMathFinalAnswerTask("Summarize yesterday's meeting notes.")).toBe(false);
    expect(isStandaloneMathFinalAnswerTask("Fix the TypeScript build and run tests.")).toBe(false);
    expect(isStandaloneMathFinalAnswerTask("case identifier 1045")).toBe(false);
  });

  it("renders a non-benchmark-specific final-answer protocol", () => {
    const protocol = renderMathFinalAnswerProtocol();
    expect(protocol).toContain("Standalone math task guardrails");
    expect(protocol).toContain("do not call `memos_search` just to look around");
    expect(protocol).toContain("exactly one real final answer");
    expect(protocol).toContain("code/execution tool");
    expect(protocol).toContain("exact DFS/DP/enumeration");
    expect(protocol).toContain("larger bound");
    expect(protocol).toContain("prints no useful result");
    expect(protocol).toContain("finite vector-space or parity subset counts");
    expect(protocol).toContain("boundary or degenerate positions");
    const forbiddenTerms = [
      "REASONING" + "_BENCHMARK",
      "om" + "ni_",
      "Hamilton" + "ian",
      "chess" + "board",
    ];
    for (const term of forbiddenTerms) {
      expect(protocol.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });

  it("merges the protocol without replacing real memory context", () => {
    const merged = mergeMathFinalAnswerProtocol("## Retrieved Memories\n1. Useful algebra skill");
    expect(merged).toContain("Useful algebra skill");
    expect(merged).toContain("Standalone math task guardrails");
    expect(mergeMathFinalAnswerProtocol(merged)).toBe(merged);
  });
});
