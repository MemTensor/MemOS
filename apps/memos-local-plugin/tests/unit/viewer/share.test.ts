import { describe, expect, it } from "vitest";

import { effectiveShareScope } from "../../../viewer/src/utils/share";

describe("effectiveShareScope", () => {
  it("shows private when the global sharing switch is off", () => {
    expect(effectiveShareScope("hub", false)).toBe("private");
    expect(effectiveShareScope("public", false)).toBe("private");
    expect(effectiveShareScope("private", false)).toBe("private");
    expect(effectiveShareScope(null, false)).toBe("private");
  });

  it("preserves the user's per-item sharing intent when sharing is on", () => {
    expect(effectiveShareScope("hub", true)).toBe("hub");
    expect(effectiveShareScope("public", true)).toBe("public");
    expect(effectiveShareScope("private", true)).toBe("private");
    expect(effectiveShareScope(undefined, true)).toBe("private");
  });
});
