import { describe, expect, it } from "vitest";

import {
  DECISION_REPAIR_PROMPT,
  L2_INDUCTION_PROMPT,
  REFLECTION_SCORE_PROMPT,
  REWARD_R_HUMAN_PROMPT,
  SKILL_CRYSTALLIZE_PROMPT,
  languageSteeringLine,
} from "../../../core/llm/index.js";

describe("llm/prompts", () => {
  const all = [
    REFLECTION_SCORE_PROMPT,
    REWARD_R_HUMAN_PROMPT,
    L2_INDUCTION_PROMPT,
    DECISION_REPAIR_PROMPT,
    SKILL_CRYSTALLIZE_PROMPT,
  ];

  it("every prompt has a non-empty id/version/system", () => {
    for (const p of all) {
      expect(p.id).toMatch(/^[a-z][a-z0-9_.]+$/);
      expect(p.version).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(8);
      expect(p.system.length).toBeGreaterThan(64);
    }
  });

  it("prompt ids are unique", () => {
    const ids = all.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("languageSteeringLine maps the three modes", () => {
    expect(languageSteeringLine("auto")).toMatch(/same natural language/i);
    expect(languageSteeringLine("zh")).toMatch(/中文/);
    expect(languageSteeringLine("en")).toMatch(/English/);
  });
});
