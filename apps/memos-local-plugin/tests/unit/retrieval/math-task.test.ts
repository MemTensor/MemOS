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

  it("does not classify algorithmic code-generation tasks as standalone math", () => {
    expect(
      isStandaloneMathFinalAnswerTask(
        [
          "Implement a Python method that returns the number of valid integers modulo 10^9 + 7.",
          "Use the provided function signature and return only the completed code.",
          "```python",
          "class Counter:",
          "    def count(self, num1: str, num2: str, min_sum: int, max_sum: int) -> int:",
          "        pass",
          "```",
        ].join("\n"),
      ),
    ).toBe(false);

    expect(
      isStandaloneMathFinalAnswerTask(
        [
          "Find the sum, modulo 998244353, of f(P) over all permutations P.",
          "Input",
          "The input is given from Standard Input in the following format:",
          "N",
          "Output",
          "Print the sum modulo 998244353.",
          "Sample Input 1",
          "3",
          "Sample Output 1",
          "1332",
          "Read the input from stdin and write the answer to stdout.",
        ].join("\n"),
      ),
    ).toBe(false);

    expect(
      isStandaloneMathFinalAnswerTask(
        [
          "You are an expert Python programmer.",
          "You will be given a problem specification and will generate a correct Python program that passes all tests.",
          "### Question:",
          "There are N people around a circle. Compute the number of valid colorings modulo a prime.",
          "Read from standard input and print the answer to standard output.",
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("renders a generic final-answer protocol", () => {
    const protocol = renderMathFinalAnswerProtocol(
      "How many routes are there in this finite graph? Compute the final answer.",
    );
    expect(protocol).toContain("Standalone math task guardrails");
    expect(protocol).toContain("do not call `memos_search` just to look around");
    expect(protocol).toContain("exactly one real final answer");
    expect(protocol).toContain("code/execution tool");
    expect(protocol).toContain("exact DFS/DP/enumeration");
    expect(protocol).toContain("larger bound only if both runs finish immediately");
    expect(protocol).toContain("run at most one short exact script");
    expect(protocol).toContain("Poll at most once");
    expect(protocol).toContain("finite vector-space or parity subset counts");
    expect(protocol).toContain("boundary or degenerate positions");
    const forbiddenTerms = [
      "SWE-Bench",
      "EvoAgentBench",
      "omni_",
      "HMMT",
      "patterns8",
      "Django",
      "Solve the following math competition problem",
    ];
    for (const term of forbiddenTerms) {
      expect(protocol).not.toContain(term);
    }
  });

  it("merges the protocol without replacing real memory context", () => {
    const merged = mergeMathFinalAnswerProtocol("## Retrieved Memories\n1. Useful algebra skill");
    expect(merged).toContain("Useful algebra skill");
    expect(merged).toContain("Standalone math task guardrails");
    expect(mergeMathFinalAnswerProtocol(merged)).toBe(merged);
  });
});
