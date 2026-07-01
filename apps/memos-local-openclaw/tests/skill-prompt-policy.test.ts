import { describe, expect, it } from "vitest";

import { CREATE_EVAL_PROMPT } from "../src/skill/evaluator";
import { STEP1_SKILL_MD_PROMPT } from "../src/skill/generator";

describe("skill prompt policy", () => {
  it("filters low-reuse tasks before generating skills", () => {
    expect(CREATE_EVAL_PROMPT).toContain("Simple tool installation plus basic");
    expect(CREATE_EVAL_PROMPT).toContain("revert, abandon, or keep the original approach");
    expect(CREATE_EVAL_PROMPT).toContain("discussion, comparison, or evaluation");
    expect(CREATE_EVAL_PROMPT).toContain(
      "would they already know how to handle it without this skill?",
    );
  });

  it("asks the generator to abstract reusable patterns", () => {
    expect(STEP1_SKILL_MD_PROMPT).toContain("Pattern over procedure");
    expect(STEP1_SKILL_MD_PROMPT).toContain("Abstract the mistake");
    expect(STEP1_SKILL_MD_PROMPT).toContain("project name, product version");
  });
});
