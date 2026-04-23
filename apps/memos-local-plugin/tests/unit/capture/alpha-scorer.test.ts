import { beforeAll, describe, expect, it } from "vitest";

import { disabledScore, scoreReflection } from "../../../core/capture/alpha-scorer.js";
import type { NormalizedStep } from "../../../core/capture/types.js";
import { REFLECTION_SCORE_PROMPT } from "../../../core/llm/prompts/reflection.js";
import { initTestLogger } from "../../../core/logger/index.js";
import { fakeLlm, throwingLlm } from "../../helpers/fake-llm.js";

const op = `capture.alpha.${REFLECTION_SCORE_PROMPT.id}.v${REFLECTION_SCORE_PROMPT.version}`;

function step(partial: Partial<NormalizedStep> = {}): NormalizedStep {
  return {
    key: "k",
    ts: 1_000,
    userText: partial.userText ?? "do a thing",
    agentText: partial.agentText ?? "did the thing",
    toolCalls: partial.toolCalls ?? [],
    rawReflection: null,
    depth: 0,
    isSubagent: false,
    meta: {},
    truncated: false,
  };
}

describe("capture/alpha-scorer", () => {
  beforeAll(() => initTestLogger());

  it("returns clamped α and model for usable reflections", async () => {
    const llm = fakeLlm({
      completeJson: {
        [op]: { alpha: 0.82, usable: true, reason: "clear causal claim" },
      },
    });
    const out = await scoreReflection(llm, {
      step: step(),
      reflectionText: "I tried X because Y, which matches last week's pattern.",
    });
    expect(out.alpha).toBeCloseTo(0.82, 5);
    expect(out.usable).toBe(true);
    expect(out.model).toBe("openai_compatible");
    expect(out.reason).toContain("clear");
  });

  it("forces α=0 when usable=false", async () => {
    const llm = fakeLlm({
      completeJson: {
        [op]: { alpha: 0.9, usable: false, reason: "tautological" },
      },
    });
    const out = await scoreReflection(llm, {
      step: step(),
      reflectionText: "I did this because I needed to do this.",
    });
    expect(out.alpha).toBe(0);
    expect(out.usable).toBe(false);
  });

  it("clamps out-of-range α values", async () => {
    const llm = fakeLlm({
      completeJson: {
        [op]: { alpha: 1.7, usable: true, reason: "x" },
      },
    });
    const out = await scoreReflection(llm, {
      step: step(),
      reflectionText: "r",
    });
    expect(out.alpha).toBe(1);
  });

  it("negative α is clamped to 0", async () => {
    const llm = fakeLlm({
      completeJson: {
        [op]: { alpha: -0.5, usable: true, reason: "x" },
      },
    });
    const out = await scoreReflection(llm, { step: step(), reflectionText: "r" });
    expect(out.alpha).toBe(0);
  });

  it("non-finite α becomes 0", async () => {
    const llm = fakeLlm({
      completeJson: {
        [op]: { alpha: Number.NaN, usable: true, reason: "x" },
      },
    });
    const out = await scoreReflection(llm, { step: step(), reflectionText: "r" });
    expect(out.alpha).toBe(0);
  });

  it("propagates LLM errors to the caller", async () => {
    const llm = throwingLlm(new Error("boom"));
    await expect(
      scoreReflection(llm, { step: step(), reflectionText: "r" }),
    ).rejects.toThrow();
  });

  it("disabledScore assigns neutral α=0.5 when text present", () => {
    const s = disabledScore("something real", "extracted");
    expect(s.alpha).toBe(0.5);
    expect(s.usable).toBe(true);
    expect(s.source).toBe("extracted");
  });

  it("disabledScore assigns α=0, usable=false when null", () => {
    const s = disabledScore(null, "none");
    expect(s.alpha).toBe(0);
    expect(s.usable).toBe(false);
    expect(s.text).toBeNull();
  });

  it("uses the right op so the prompt registry tag is stable", async () => {
    const captured: string[] = [];
    const llm = fakeLlm({
      completeJson: {
        [op]: (_input: unknown) => {
          captured.push(op);
          return { alpha: 0.5, usable: true, reason: "ok" };
        },
      },
    });
    await scoreReflection(llm, { step: step(), reflectionText: "r" });
    expect(captured).toEqual([op]);
  });
});
