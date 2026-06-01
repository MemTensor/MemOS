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
  void existing;
  return { step: s };
}

describe("batchScoreReflections", () => {
  beforeAll(() => initTestLogger());

  it("empty inputs short-circuit without an LLM call", async () => {
    const llm = throwingLlm(new Error("would have crashed"));
    const out = await batchScoreReflections(llm, [], {});
    expect(out.scores).toEqual([]);
  });

  it("respects out-of-order idx in the LLM response", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: {
          scores: [
            { idx: 1, relevance: "IRRELEVANT", reason: "DETOUR" },
            { idx: 0, relevance: "PIVOTAL", reason: "TURNING_POINT" },
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
      {},
    );
    expect(out.scores[0]!.text).toBe("PIVOTAL");
    expect(out.scores[0]!.alpha).toBe(1);
    expect(out.scores[1]!.text).toBe("IRRELEVANT");
    expect(out.scores[1]!.alpha).toBe(0);
  });

  it("rejects responses with mismatched length", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: { scores: [{ idx: 0, relevance: "IRRELEVANT", reason: "DETOUR" }] },
      },
    });
    await expect(
      batchScoreReflections(
        llm,
        [
          input(step({ userText: "u0", agentText: "a0" }), "x"),
          input(step({ userText: "u1", agentText: "a1" }), "y"),
        ],
        {},
      ),
    ).rejects.toThrow(/length mismatch/);
  });

  it("keeps (relevance, alpha) when reason is missing — no MALFORMED throw", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: {
          scores: [{ idx: 0, relevance: "PIVOTAL" }],
        },
      },
    });
    const out = await batchScoreReflections(
      llm,
      [input(step({ userText: "u", agentText: "a" }), "x")],
      {},
    );
    expect(out.scores[0]!.text).toBe("PIVOTAL");
    expect(out.scores[0]!.alpha).toBe(1);
    expect(out.scores[0]!.reason).toBeNull();
  });

  it("rejects entries with illegal relevance", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: {
          scores: [{ idx: 0, relevance: "RELATED_DEFAULT", reason: "BAD_ENUM" }],
        },
      },
    });
    await expect(
      batchScoreReflections(llm, [input(step({ userText: "u", agentText: "a" }), "x")], {}),
    ).rejects.toThrow(/relevance must be IRRELEVANT\/RELATED\/PIVOTAL/);
  });

  it("maps IRRELEVANT to alpha=0", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: {
          scores: [
            {
              idx: 0,
              relevance: "IRRELEVANT",
              reason: "DETOUR",
            },
          ],
        },
      },
    });
    const out = await batchScoreReflections(
      llm,
      [input(step({ userText: "u", agentText: "a" }), null)],
      {},
    );
    expect(out.scores[0]!.text).toBe("IRRELEVANT");
    expect(out.scores[0]!.alpha).toBe(0);
    expect(out.scores[0]!.source).toBe("synth");
  });

  it("maps RELATED to alpha=0.5", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: {
          scores: [
            {
              idx: 0,
              relevance: "RELATED",
              reason: "ON_PATH",
            },
          ],
        },
      },
    });
    const out = await batchScoreReflections(
      llm,
      [input(step({ userText: "u", agentText: "a" }), null)],
      {},
    );
    expect(out.scores[0]!.text).toBe("RELATED");
    expect(out.scores[0]!.source).toBe("synth");
    expect(out.scores[0]!.alpha).toBe(0.5);
  });

  it("maps PIVOTAL to alpha=1", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: {
          scores: [{ idx: 0, relevance: "PIVOTAL", reason: "RECOVERY" }],
        },
      },
    });
    const out = await batchScoreReflections(
      llm,
      [input(step({ userText: "u", agentText: "a" }), null)],
      {},
    );
    expect(out.scores[0]!.text).toBe("PIVOTAL");
    expect(out.scores[0]!.alpha).toBe(1);
  });

  it("forces social-only turns to IRRELEVANT as fallback", async () => {
    const llm = fakeLlm({
      completeJson: {
        [BATCH_OP_TAG]: {
          scores: [{ idx: 0, relevance: "PIVOTAL", reason: "TURNING_POINT" }],
        },
      },
    });
    const out = await batchScoreReflections(
      llm,
      [
        input(
          step({
            userText: "你做的很对，运行起来也很流畅，棒！",
            agentText: "谢谢夸奖！有需要随时说。",
            toolCalls: [],
          }),
          null,
        ),
      ],
      {},
    );
    expect(out.scores[0]!.text).toBe("IRRELEVANT");
    expect(out.scores[0]!.alpha).toBe(0);
    expect(out.scores[0]!.reason).toBe("SOCIAL_ONLY");
  });
});
