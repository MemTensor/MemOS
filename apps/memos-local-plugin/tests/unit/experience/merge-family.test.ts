import { describe, expect, it } from "vitest";

import { deriveMergeFamily } from "../../../core/experience/merge-family.js";

describe("deriveMergeFamily", () => {
  it("maps l2 induction to success_induction", () => {
    const family = deriveMergeFamily({
      experienceType: "repair_instruction",
      evidencePolarity: "positive",
      inducedBy: "l2.induction.v1",
    });
    expect(family).toBe("success_induction");
  });

  it("maps negative repair instruction to failure_avoidance", () => {
    const family = deriveMergeFamily({
      experienceType: "repair_instruction",
      evidencePolarity: "negative",
      inducedBy: "feedback.experience.v1",
    });
    expect(family).toBe("failure_avoidance");
  });

  it("maps non-negative failure family to failure_corrective", () => {
    const family = deriveMergeFamily({
      experienceType: "repair_instruction",
      evidencePolarity: "mixed",
      inducedBy: "feedback.experience.v1",
    });
    expect(family).toBe("failure_corrective");
  });
});
