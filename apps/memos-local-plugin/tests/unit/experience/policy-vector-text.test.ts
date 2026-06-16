import { describe, expect, it } from "vitest";

import { buildPolicyVectorText } from "../../../core/experience/policy-vector-text.js";

describe("policy vector text", () => {
  it("uses only title and trigger for policy embeddings", () => {
    expect(
      buildPolicyVectorText({
        title: "Retry pip with system headers",
        trigger: "pip install fails while building native wheel",
        procedure: "Install python-dev and retry pip.",
        verification: "pytest passes",
        boundary: "Only for Alpine images",
      }),
    ).toBe("Retry pip with system headers\npip install fails while building native wheel");
  });

  it("falls back to empty marker when title and trigger are empty", () => {
    expect(buildPolicyVectorText({ title: "", trigger: "  " })).toBe("(empty)");
  });
});
