/**
 * Regression test for issue #2469 — the capture summarizer was writing
 * Chinese summaries for English conversations because the SYSTEM_PROMPT
 * (a) anchored the language rule on an ambiguous referent ("the user's
 * original language") and (b) carried a single CJK example ("用户说了")
 * that primed the model toward Chinese output under the 100-char cap.
 *
 * These tests do not call a real LLM. Instead they install a spy
 * `LlmClient.completeJson` that records the exact `messages` array
 * the summarizer sends, and assert on the system-prompt content.
 *
 * If these assertions start failing, the prompt text has drifted;
 * revisit issue #2469 before loosening them.
 */

import { describe, expect, it } from "vitest";

import { createSummarizer } from "../../../core/capture/summarizer.js";
import type { NormalizedStep } from "../../../core/capture/types.js";
import type {
  LlmClient,
  LlmJsonCompletion,
  LlmMessage,
} from "../../../core/llm/types.js";
import type { EpochMs } from "../../../core/types.js";

function makeStep(partial: Partial<NormalizedStep> = {}): NormalizedStep {
  return {
    key: partial.key ?? "s1",
    ts: partial.ts ?? ((1_700_000_000_000 as unknown) as EpochMs),
    userText: partial.userText ?? "",
    agentText: partial.agentText ?? "",
    toolCalls: partial.toolCalls ?? [],
    rawReflection: partial.rawReflection ?? null,
    depth: partial.depth ?? 0,
    isSubagent: partial.isSubagent ?? false,
    meta: partial.meta ?? {},
    truncated: partial.truncated ?? false,
  };
}

interface SpyRecorder {
  calls: Array<{ messages: LlmMessage[] }>;
}

function spyLlm(recorder: SpyRecorder, summary = "ok"): LlmClient {
  return {
    provider: "openai_compatible",
    model: "spy-model",
    canStream: false,
    async complete() {
      throw new Error("spyLlm.complete not expected");
    },
    async completeJson<T>(
      messages: LlmMessage[] | string,
    ): Promise<LlmJsonCompletion<T>> {
      recorder.calls.push({
        messages: Array.isArray(messages) ? messages : [],
      });
      const value = { summary } as unknown as T;
      return {
        value,
        raw: JSON.stringify(value),
        provider: "openai_compatible",
        model: "spy-model",
        finishReason: "stop",
        servedBy: "openai_compatible",
        durationMs: 1,
      };
    },
    stream(): AsyncIterable<never> {
      return (async function* () {})();
    },
    stats() {
      return {
        provider: "openai_compatible",
        model: "spy-model",
        requests: 0,
        failures: 0,
        malformedJson: 0,
        timeouts: 0,
        circuitOpen: false,
        circuitOpenUntil: null,
        circuitOpenedReason: null,
      };
    },
    resetStats() {},
    async close() {},
  };
}

describe("capture/summarizer SYSTEM_PROMPT (issue #2469)", () => {
  it("does not contain the Chinese '用户说了' example", async () => {
    const recorder: SpyRecorder = { calls: [] };
    const summarizer = createSummarizer({ llm: spyLlm(recorder) });

    await summarizer.summarize(
      makeStep({ userText: "Hey, kick off a heartbeat please" }),
    );

    expect(recorder.calls).toHaveLength(1);
    const sys = recorder.calls[0]!.messages.find((m) => m.role === "system");
    expect(sys).toBeTruthy();
    // No CJK example may leak into the prompt — that is what primed the
    // model toward Chinese output on some backends.
    expect(sys!.content).not.toContain("用户说了");
    // Nothing with Han characters at all; keep the rail tight.
    expect(/[一-鿿]/.test(sys!.content)).toBe(false);
  });

  it("anchors the language rule on the USER text, not an ambiguous referent", async () => {
    const recorder: SpyRecorder = { calls: [] };
    const summarizer = createSummarizer({ llm: spyLlm(recorder) });

    await summarizer.summarize(makeStep({ userText: "hello" }));

    const sys = recorder.calls[0]!.messages.find((m) => m.role === "system");
    expect(sys).toBeTruthy();
    // Must point at the USER text as the language source so the model
    // cannot drift toward a different language when the only non-English
    // token in context is incidental.
    expect(sys!.content).toContain("USER text");
    // The pre-fix wording ("in the user's original language") was the
    // ambiguous one that triggered this bug. Guard against regressions
    // that silently reintroduce it.
    expect(sys!.content).not.toContain("original language");
  });
});
