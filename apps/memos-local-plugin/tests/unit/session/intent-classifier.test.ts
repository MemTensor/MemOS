import { beforeAll, describe, expect, it } from "vitest";

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { createIntentClassifier } from "../../../core/session/intent-classifier.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type { LlmClient, LlmJsonCompletion } from "../../../core/llm/types.js";

function fakeLlm(handler: (input: unknown) => unknown | Promise<unknown>): LlmClient {
  return {
    provider: "openai_compatible",
    model: "fake",
    canStream: false,
    async complete(): Promise<never> {
      throw new Error("not used");
    },
    async completeJson<T>(_input: unknown, _opts: unknown): Promise<LlmJsonCompletion<T>> {
      const value = (await handler(_input)) as T;
      const opts = _opts as { validate?: (v: unknown) => void } | undefined;
      if (opts?.validate) opts.validate(value);
      return {
        value,
        raw: JSON.stringify(value),
        provider: "openai_compatible",
        model: "fake",
        finishReason: "stop",
        usage: undefined,
        servedBy: "openai_compatible",
        durationMs: 2,
      };
    },
    async *stream() {
      /* noop */
    },
    stats: () => ({
      requests: 0,
      hostFallbacks: 0,
      failures: 0,
      retries: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      lastOkAt: null,
      lastFallbackAt: null,
      lastError: null,
    }),
    resetStats: () => {},
    close: async () => {},
  };
}

describe("session/intent-classifier", () => {
  beforeAll(() => initTestLogger());

  it("empty message → chitchat with zero LLM calls", async () => {
    let calls = 0;
    const c = createIntentClassifier({
      llm: fakeLlm(() => {
        calls++;
        return { kind: "task", confidence: 1, reason: "x" };
      }),
    });
    const d = await c.classify("   ");
    expect(d.kind).toBe("chitchat");
    expect(d.retrieval).toEqual({ tier1: false, tier2: false, tier3: false });
    expect(calls).toBe(0);
  });

  it("strong heuristic short-circuits LLM", async () => {
    let calls = 0;
    const c = createIntentClassifier({
      llm: fakeLlm(() => {
        calls++;
        return { kind: "task", confidence: 1, reason: "x" };
      }),
    });
    const d = await c.classify("/memos status");
    expect(d.kind).toBe("meta");
    expect(d.confidence).toBeGreaterThan(0.9);
    expect(d.signals[0]).toBe("meta.command_prefix");
    expect(calls).toBe(0);
  });

  it("weak heuristic hits + LLM elevates to confident decision", async () => {
    // "please help" is an imperative (weak, conf 0.75). LLM should boost to task.
    const c = createIntentClassifier({
      llm: fakeLlm(() => ({
        kind: "task",
        confidence: 0.92,
        reason: "clear imperative request",
      })),
    });
    const d = await c.classify("please help me refactor this config");
    expect(d.kind).toBe("task");
    expect(d.confidence).toBeCloseTo(0.92, 2);
    expect(d.signals).toContain("llm");
    expect(d.signals.some((s) => s.startsWith("heuristic:"))).toBe(true);
  });

  it("no heuristic match + LLM ok", async () => {
    const c = createIntentClassifier({
      llm: fakeLlm(() => ({
        kind: "memory_probe",
        confidence: 0.8,
        reason: "asks about earlier session",
      })),
    });
    const d = await c.classify("anything similar in what we did earlier?");
    expect(d.kind).toBe("memory_probe");
    expect(d.retrieval).toEqual({ tier1: true, tier2: true, tier3: false });
    expect(d.signals).toEqual(["llm"]);
  });

  it("LLM failure falls back to heuristic", async () => {
    const c = createIntentClassifier({
      llm: fakeLlm(() => {
        throw new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "down");
      }),
    });
    const d = await c.classify("please fix the bug");
    expect(d.kind).toBe("task");
    expect(d.signals).toContain("task.imperative_verb");
    expect(d.signals).toContain("llm_skipped");
  });

  it("LLM failure with no heuristic match → unknown (full retrieval)", async () => {
    const c = createIntentClassifier({
      llm: fakeLlm(() => {
        throw new Error("500");
      }),
    });
    const d = await c.classify("what if");
    expect(d.kind).toBe("unknown");
    expect(d.retrieval).toEqual({ tier1: true, tier2: true, tier3: true });
    expect(d.signals).toEqual(["default_unknown"]);
  });

  it("LLM timeout honored", async () => {
    const c = createIntentClassifier({
      llm: fakeLlm(async () => {
        await new Promise((r) => setTimeout(r, 80));
        return { kind: "task", confidence: 0.9, reason: "x" };
      }),
      timeoutMs: 20,
    });
    const d = await c.classify("please make it faster");
    // Falls back to heuristic (task.imperative_verb).
    expect(d.kind).toBe("task");
    expect(d.signals).toContain("llm_skipped");
  });

  it("malformed LLM output → heuristic fallback (no throw)", async () => {
    const c = createIntentClassifier({
      llm: fakeLlm(() => ({
        kind: "not_a_real_label",
        confidence: 1,
        reason: "x",
      })),
    });
    const d = await c.classify("please ship it");
    expect(d.kind).toBe("task");
    expect(d.signals).toContain("llm_skipped");
  });

  it("disableLlm=true skips classifier even when llm given", async () => {
    let calls = 0;
    const c = createIntentClassifier({
      llm: fakeLlm(() => {
        calls++;
        return {};
      }),
      disableLlm: true,
    });
    await c.classify("a random sentence with no cues");
    expect(calls).toBe(0);
  });

  it("retrieval flags follow kind on all happy paths", async () => {
    const c = createIntentClassifier({
      llm: fakeLlm(() => ({ kind: "chitchat", confidence: 0.9, reason: "x" })),
    });
    const d = await c.classify("ambiguous but yeah");
    expect(d.retrieval).toEqual({ tier1: false, tier2: false, tier3: false });
  });
});
