import { describe, it, expect } from "vitest";

import { mergeRebuildDraft } from "../../../core/skill/merge.js";
import { makeDraft } from "./_helpers.js";
import type { SkillProcedure } from "../../../core/skill/types.js";

const existing: SkillProcedure = {
  summary: "old summary",
  retrievalBlurb: "old blurb",
  policyContentHash: "abc",
  parameters: [],
  preconditions: [],
  steps: [
    { title: "step A", body: "body A" },
    { title: "step B", body: "body B" },
  ],
  examples: [],
  decisionGuidance: { preference: ["Prefer: A"], antiPattern: [] },
  tags: [],
  tools: ["bash"],
};

describe("skill/merge", () => {
  it("L0 keeps steps and only applies blurb/summary from draft", () => {
    const draft = makeDraft({
      summary: "new summary",
      retrievalBlurb: "new blurb",
      steps: [{ title: "replaced", body: "gone" }],
      tools: ["new_tool"],
    });
    const merged = mergeRebuildDraft(draft, existing, {
      level: "L0",
      lockName: "locked_name",
    });
    expect(merged.name).toBe("locked_name");
    expect(merged.summary).toBe("new summary");
    expect(merged.retrievalBlurb).toBe("new blurb");
    expect(merged.steps).toEqual(existing.steps);
    expect(merged.tools).toEqual(existing.tools);
  });

  it("L2 replaces steps from draft", () => {
    const draft = makeDraft({
      steps: [{ title: "new only", body: "new body" }],
    });
    const merged = mergeRebuildDraft(draft, existing, {
      level: "L2",
      lockName: "locked_name",
    });
    expect(merged.steps[0]!.title).toBe("new only");
  });
});
