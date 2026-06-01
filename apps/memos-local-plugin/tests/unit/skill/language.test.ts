import { describe, expect, it } from "vitest";

import { resolveSkillOutputLanguage } from "../../../core/skill/language.js";
import type { PolicyRow } from "../../../core/types.js";

function policy(partial: Partial<PolicyRow> = {}): Pick<
  PolicyRow,
  "title" | "trigger" | "procedure" | "boundary"
> {
  return {
    title: partial.title ?? "修复补丁应用失败",
    trigger: partial.trigger ?? "当用户要求修复仓库补丁问题时",
    procedure: partial.procedure ?? "通过补丁机制应用修改并验证结果",
    boundary: partial.boundary ?? "仅限仓库文件修改",
  };
}

describe("skill/language", () => {
  it("follows policy language by default", () => {
    const lang = resolveSkillOutputLanguage(policy(), { outputLanguageMode: "follow_policy" });
    expect(lang).toBe("zh");
  });

  it("supports forced language override", () => {
    expect(resolveSkillOutputLanguage(policy(), { outputLanguageMode: "en" })).toBe("en");
    expect(resolveSkillOutputLanguage(policy(), { outputLanguageMode: "zh" })).toBe("zh");
  });
});
