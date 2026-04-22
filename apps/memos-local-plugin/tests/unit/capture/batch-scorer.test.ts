/**
 * Unit tests for `core/capture/batch-scorer.ts`.
 *
 * These poke directly at the batched LLM client so we can validate the
 * payload shape, validator, and fallback behavior in isolation. End-to-end
 * dispatch wiring is covered by `tests/unit/capture/capture-batch.test.ts`.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  BATCH_OP_TAG,
  batchScoreReflections,
  type BatchScoreInput,
} from "../../../core/capture/batch-scorer.js";
import type { NormalizedStep } from "../../../core/capture/types.js";
import { initTestLogger } from "../../../core/logger/index.js";
import { fakeLlm, throwingLlm } from "../../helpers/fake-llm.js";

function step(
  partial: Partial<NormalizedStep> & Pick<NormalizedStep, "userText" | "agentText">,
): NormalizedStep {
  return {
    key: partial.key ?? "k",
    ts: partial.ts ?? 1_000,
    userText: partial.userText,
    agentText: partial.agentText,
    toolCalls: partial.toolCalls ?? [],
    rawReflection: partial.rawReflection ?? null,
    depth: partial.depth ?? 0,
    isSubagent: partial.isSubagent ?? false,
    meta: partial.meta ?? {},
    truncated: partial.truncated ?? false,
  };
}

function input(s: NormalizedStep, existing: string | null = null): BatchScoreInput {
  return { step: s, existingReflection: existing };
}

describe("batchScoreReflections", () => {
  beforeAll(() => initTestLogger());

  it("empty inputs short-circuit without an LLM call", async () => {
    const llm = throwingLlm(new Error("would have crashed"));
    const out = await batchScoreReflections(llm, [], { synthReflections: true });
    expect(out.scores).toEqual([]);
    expect(out.synthAccepted).toBe(0);
  });

  it("respects out-of-order idx in the LLM response", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: {
          scores: [
            { idx: 1, reflection_text: "second", alpha: 0.4, usable: true },
            { idx: 0, reflection_text: "first", alpha: 0.7, usable: true },
          ],
        },
      },
    });
    const out = await batchScoreReflections(
      llm,
      [
        input(step({ userText: "u0", agentText: "a0" }), "first"),
        input(step({ userText: "u1", agentText: "a1" }), "second"),
      ],
      { synthReflections: true },
    );
    expect(out.scores[0]!.text).toBe("first");
    expect(out.scores[0]!.alpha).toBeCloseTo(0.7, 5);
    expect(out.scores[1]!.text).toBe("second");
    expect(out.scores[1]!.alpha).toBeCloseTo(0.4, 5);
  });

  it("rejects responses with mismatched length", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: { scores: [{ idx: 0, reflection_text: "x", alpha: 0.5, usable: true }] },
      },
    });
    await expect(
      batchScoreReflections(
        llm,
        [
          input(step({ userText: "u0", agentText: "a0" }), "x"),
          input(step({ userText: "u1", agentText: "a1" }), "y"),
        ],
        { synthReflections: true },
      ),
    ).rejects.toThrow(/length mismatch/);
  });

  it("rejects entries with non-number alpha", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: {
          scores: [{ idx: 0, reflection_text: "x", alpha: "bad", usable: true }],
        },
      },
    });
    await expect(
      batchScoreReflections(llm, [input(step({ userText: "u", agentText: "a" }), "x")], {
        synthReflections: true,
      }),
    ).rejects.toThrow(/alpha must be number/);
  });

  it("synth disabled + empty existing → discards LLM-written text, α=0", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: {
          scores: [
            {
              idx: 0,
              reflection_text: "Confidently fabricated reflection.",
              alpha: 0.8,
              usable: true,
            },
          ],
        },
      },
    });
    const out = await batchScoreReflections(
      llm,
      [input(step({ userText: "u", agentText: "a" }), null)],
      { synthReflections: false },
    );
    expect(out.scores[0]!.text).toBeNull();
    expect(out.scores[0]!.alpha).toBe(0);
    expect(out.scores[0]!.source).toBe("none");
    expect(out.synthAccepted).toBe(0);
  });

  it("synth enabled + empty existing → adopts LLM text and reports synthAccepted", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: {
          scores: [
            {
              idx: 0,
              reflection_text: "I picked tool X because the user asked for Y.",
              alpha: 0.6,
              usable: true,
            },
          ],
        },
      },
    });
    const out = await batchScoreReflections(
      llm,
      [input(step({ userText: "u", agentText: "a" }), null)],
      { synthReflections: true },
    );
    expect(out.scores[0]!.text).toContain("tool X");
    expect(out.scores[0]!.source).toBe("synth");
    expect(out.synthAccepted).toBe(1);
  });
});
