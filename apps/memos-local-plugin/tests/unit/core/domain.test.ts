import { describe, expect, it } from "vitest";

import {
  effectiveReadOnlyInjectionProfile,
  effectiveSkillInjectionMode,
  isIrDomain,
} from "../../../core/domain.js";

describe("domain helpers", () => {
  it("isIrDomain is true only for ir", () => {
    expect(isIrDomain("ir")).toBe(true);
    expect(isIrDomain("")).toBe(false);
    expect(isIrDomain(undefined)).toBe(false);
  });

  it("effectiveSkillInjectionMode forces summary outside ir", () => {
    expect(
      effectiveSkillInjectionMode({ domain: "", skillInjectionMode: "full" }),
    ).toBe("summary");
    expect(
      effectiveSkillInjectionMode({ domain: "ir", skillInjectionMode: "full" }),
    ).toBe("full");
  });

  it("effectiveReadOnlyInjectionProfile forces all outside ir", () => {
    expect(
      effectiveReadOnlyInjectionProfile({
        domain: "",
        readOnlyInjectionProfile: "skill",
      }),
    ).toBe("all");
    expect(
      effectiveReadOnlyInjectionProfile({
        domain: "ir",
        readOnlyInjectionProfile: "skill",
      }),
    ).toBe("skill");
  });
});
