import { describe, it, expect } from "vitest";
import {
  shouldSkipOrSearch,
  parseLLMIntent,
  executeIntentJudge,
  resolveAutoRecallMaxResults,
} from "../src/intent-filter";

describe("intent-filter: shouldSkipOrSearch", () => {
  it("should skip simple continue command (zh)", () => {
    expect(shouldSkipOrSearch("继续").action).toBe("skip");
  });

  it("should skip continue command with surrounding spaces", () => {
    expect(shouldSkipOrSearch("  continue  ").action).toBe("skip");
  });

  it("should skip simple continue command (en)", () => {
    expect(shouldSkipOrSearch("continue").action).toBe("skip");
  });

  it("should search for explicit memory query (en)", () => {
    expect(shouldSkipOrSearch("Do you remember what we discussed last time about pricing?").action).toBe("search");
  });
});

describe("intent-filter: parseLLMIntent", () => {
  it("parses Chinese label output", () => {
    const out = `意图: 记忆检索\n置信度: 高\n原因: 明确提到过去对话`;
    const parsed = parseLLMIntent(out, "explicit search (zh)");
    expect(parsed.action).toBe("search");
  });

  it("parses English label output", () => {
    const out = `Intent: Memory Retrieval\nConfidence: High\nReason: asks about previous discussion`;
    const parsed = parseLLMIntent(out, "last discussion");
    expect(parsed.action).toBe("search");
  });

  it("parses JSON output", () => {
    const out = JSON.stringify({ intent: "Memory Retrieval", confidence: "High", reason: "explicit past reference" });
    const parsed = parseLLMIntent(out, "previous topic");
    expect(parsed.action).toBe("search");
  });

  it("parses JSON snippet from mixed text", () => {
    const out = `Some preface text\n{"intent":"Memory Retrieval","confidence":"High"}\nSome suffix text`;
    const parsed = parseLLMIntent(out, "previous topic");
    expect(parsed.action).toBe("search");
  });

  it("supports medium threshold by option", () => {
    const out = `Intent: Memory Retrieval\nConfidence: medium\nReason: mentions previous issue`;
    const parsedDefault = parseLLMIntent(out, "previous issue");
    const parsedMedium = parseLLMIntent(out, "previous issue", { minConfidenceForSearch: "medium" });
    expect(parsedDefault.action).toBe("skip");
    expect(parsedMedium.action).toBe("search");
  });
});

describe("intent-filter: executeIntentJudge", () => {
  it("returns shouldSearch=false when LLM fails and fallback=skip", async () => {
    const summarizer = {
      summarize: async () => {
        throw new Error("network");
      },
    };
    const logs: string[] = [];
    const ctx = {
      log: {
        debug: (_m: string) => {},
        info: (_m: string) => {},
        warn: (m: string) => logs.push(m),
      },
    };
    const store = {
      recordToolCall: (_name: string, _dur: number, _success: boolean) => {},
      recordApiLog: (_name: string, _payload: unknown, _result: string, _dur: number, _success: boolean) => {},
    };
    const perf = { now: () => 1000 };

    const result = await executeIntentJudge({
      query: "optimise this",
      summarizer,
      ctx,
      store,
      recallT0: 900,
      performance: perf,
      options: { onLlmError: "skip" },
    });

    expect(result.shouldSearch).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("returns shouldSearch=true when LLM fails and fallback=search", async () => {
    const summarizer = {
      summarize: async () => {
        throw new Error("timeout");
      },
    };
    const ctx = {
      log: {
        debug: (_m: string) => {},
        info: (_m: string) => {},
        warn: (_m: string) => {},
      },
    };
    const store = {
      recordToolCall: (_name: string, _dur: number, _success: boolean) => {},
      recordApiLog: (_name: string, _payload: unknown, _result: string, _dur: number, _success: boolean) => {},
    };
    const perf = { now: () => 1000 };

    const result = await executeIntentJudge({
      query: "optimise this",
      summarizer,
      ctx,
      store,
      recallT0: 900,
      performance: perf,
      options: { onLlmError: "search" },
    });

    expect(result.shouldSearch).toBe(true);
  });

  it("returns shouldSearch=false on timeout when fallback=skip", async () => {
    const summarizer = {
      summarize: async () => await new Promise<string | null>(() => {}),
    };
    const ctx = {
      log: {
        debug: (_m: string) => {},
        info: (_m: string) => {},
        warn: (_m: string) => {},
      },
    };
    const store = {
      recordToolCall: (_name: string, _dur: number, _success: boolean) => {},
      recordApiLog: (_name: string, _payload: unknown, _result: string, _dur: number, _success: boolean) => {},
    };
    const perf = { now: () => 1000 };

    const result = await executeIntentJudge({
      query: "please optimize this",
      summarizer,
      ctx,
      store,
      recallT0: 900,
      performance: perf,
      options: { llmTimeoutMs: 1, onLlmError: "skip" },
    });

    expect(result.shouldSearch).toBe(false);
  });
});

describe("intent-filter: resolveAutoRecallMaxResults", () => {
  it("clamps range to 1..20", () => {
    expect(resolveAutoRecallMaxResults({ autoRecallMaxResults: 0 })).toBe(1);
    expect(resolveAutoRecallMaxResults({ autoRecallMaxResults: 99 })).toBe(20);
    expect(resolveAutoRecallMaxResults({ autoRecallMaxResults: 12 })).toBe(12);
  });

  it("uses default on invalid input", () => {
    expect(resolveAutoRecallMaxResults({ autoRecallMaxResults: Number.NaN })).toBe(10);
    expect(resolveAutoRecallMaxResults()).toBe(10);
  });
});
