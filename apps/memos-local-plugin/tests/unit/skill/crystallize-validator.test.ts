import { describe, expect, it } from "vitest";

import { defaultDraftValidator } from "../../../core/skill/crystallize.js";
import { makeDraft } from "./_helpers.js";

describe("defaultDraftValidator", () => {
  it("passes a complete draft through unchanged", () => {
    const draft = makeDraft();
    expect(() => defaultDraftValidator(draft)).not.toThrow();
    expect(draft.summary).toBe("Ensure system libs exist before pip install on alpine.");
    expect(draft.steps).toHaveLength(3);
  });

  it("never throws for a missing summary (issue #2143)", () => {
    const draft = makeDraft({ summary: "" });
    expect(() => defaultDraftValidator(draft)).not.toThrow();
  });

  it("auto-generates summary from the first step body when omitted", () => {
    const draft = makeDraft({ summary: "" });
    defaultDraftValidator(draft);
    expect(draft.summary).toBe("inspect the pip error for missing .so names");
  });

  it("falls back through step title, displayTitle, then name for the summary", () => {
    const draft = makeDraft({ summary: "", steps: [] });
    expect(() => defaultDraftValidator(draft)).toThrow(/missing steps/);
    expect(draft.summary).toBe("Alpine pip install with system deps");
  });

  it("caps the auto-generated summary at 200 chars", () => {
    const longBody = "x".repeat(500);
    const draft = makeDraft({
      summary: "",
      steps: [{ title: "t", body: longBody }],
    });
    defaultDraftValidator(draft);
    expect(draft.summary).toBe("x".repeat(200));
  });

  it("uses || not ?? — an empty-string summary still triggers the fallback", () => {
    const draft = makeDraft({ summary: "", steps: [] });
    expect(() => defaultDraftValidator(draft)).toThrow(/missing steps/);
    expect(draft.summary).not.toBe("");
  });

  it("rejects missing steps instead of inventing a generic procedure", () => {
    const draft = makeDraft({ steps: [] });
    expect(() => defaultDraftValidator(draft)).toThrow(/missing steps/);
    expect(draft.steps).toEqual([]);
  });

  it("still rejects a draft with no name", () => {
    const draft = makeDraft({ name: "" });
    expect(() => defaultDraftValidator(draft)).toThrow(/missing name/);
  });
});
