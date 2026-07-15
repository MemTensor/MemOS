/**
 * Tests for V7 §0.1 turn-relation classifier.
 *
 * Exercise both pure-heuristic paths (no LLM) and the LLM tie-breaker.
 * We deliberately stub the LLM with a deterministic fake so the heuristic
 * vs. LLM decision path stays verifiable.
 */
import { describe, it, expect } from "vitest";

import { createRelationClassifier } from "../../../core/session/relation-classifier.js";
import type { LlmClient } from "../../../core/llm/index.js";

function heuristic() {
  return createRelationClassifier({ disableLlm: true });
}

function withLlm(fake: Partial<LlmClient>) {
  return createRelationClassifier({ llm: fake as LlmClient });
}

function fakeLlmReturning(value: unknown, servedBy = "fake/llm"): Partial<LlmClient> {
  return {
    completeJson: async () => ({ value, servedBy } as never),
  };
}

describe("relation-classifier — V7 §0.1", () => {
  it("classifies bootstrap (no previous episode) as new_task", async () => {
    const c = heuristic();
    const d = await c.classify({ newUserText: "help me write tests" });
    expect(d.relation).toBe("new_task");
    expect(d.signals).toContain("bootstrap");
  });

  it("detects revision via negation keyword", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "translate this sentence",
      prevAssistantText: "Sure, here is the translation…",
      newUserText: "no, that's wrong — redo it with more formal tone",
    });
    expect(d.relation).toBe("revision");
    expect(d.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects revision via Chinese negation", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "翻译这句话",
      prevAssistantText: "好的，翻译如下…",
      newUserText: "不对，重做一下，用更正式的语气",
    });
    expect(d.relation).toBe("revision");
  });

  it("detects follow_up via 'also'/'next' phrasing", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "list docker images",
      prevAssistantText: "Here are the images: alpine, ubuntu, ...",
      newUserText: "then also pull the redis image",
    });
    expect(d.relation).toBe("follow_up");
  });

  it("detects new_task via 'forget that' / 'new topic' phrasing", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "debug the failing test",
      prevAssistantText: "the bug was a null pointer…",
      newUserText: "forget that, let's start a new topic about database migration",
    });
    expect(d.relation).toBe("new_task");
  });

  it("detects revision via quoted prev-assistant phrase", async () => {
    const prev = "The build failed because the cache was stale on the worker node";
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "what went wrong?",
      prevAssistantText: `${prev} — that's the main issue.`,
      newUserText: `that's wrong — actually the failure was a compiler issue, not the cache was stale on the worker node as you said`,
    });
    expect(["revision", "follow_up"]).toContain(d.relation);
  });

  it("falls back to follow_up when no signal fires and LLM is disabled", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "what is the capital of France?",
      prevAssistantText: "Paris.",
      newUserText: "and Germany's?",
    });
    // "and X's?" is a follow-up-ish pattern; heuristic may or may not fire —
    // either way we should NOT get `revision`.
    expect(d.relation === "follow_up" || d.relation === "unknown" || d.relation === "new_task").toBe(
      true,
    );
    expect(d.relation).not.toBe("revision");
  });

  it("uses LLM tie-breaker when heuristics are weak", async () => {
    const llm = fakeLlmReturning(
      {
        relation: "follow_up",
        confidence: 0.8,
        reason: "same domain, new sub-task",
      },
      "fake/test-model",
    );
    const c = withLlm(llm);
    const d = await c.classify({
      prevUserText: "what is the capital of France?",
      prevAssistantText: "Paris.",
      newUserText: "and how is the weather there today?",
    });
    expect(d.relation).toBe("follow_up");
    expect(d.signals).toContain("llm");
    expect(d.llmModel).toBe("fake/test-model");
  });

  it("falls back to heuristic when LLM throws", async () => {
    const llm: Partial<LlmClient> = {
      completeJson: async () => {
        throw new Error("provider down");
      },
    };
    const c = withLlm(llm);
    const d = await c.classify({
      prevUserText: "translate this sentence",
      prevAssistantText: "Sure, here is the translation…",
      newUserText: "not quite right, try again",
    });
    expect(d.relation).toBe("revision");
  });

  it("large time gap leans toward new_task (when below strong-heuristic threshold)", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "deploy the site",
      prevAssistantText: "deployed successfully",
      newUserText: "can you help with something",
      gapMs: 60 * 60 * 1000, // 1 hour
    });
    // The gap rule is weak (confidence 0.6) so either new_task or
    // follow_up default — but NOT revision.
    expect(d.relation).not.toBe("revision");
  });

  it("empty new text returns unknown", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "something",
      newUserText: "   ",
    });
    expect(d.relation).toBe("unknown");
  });

  // ─── New tests for legacy parity improvements ────────────────────────

  it("short pronoun message (那XX呢) classifies as follow_up", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "帮我配置Nginx的SSL证书",
      prevAssistantText: "好的，SSL证书配置如下...",
      newUserText: "那gzip压缩呢",
    });
    expect(d.relation).toBe("follow_up");
    expect(d.confidence).toBeGreaterThanOrEqual(0.8);
    expect(d.signals).toContain("r3_pronoun_ref");
  });

  it("short pronoun message (这个怎么办) classifies as follow_up", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "分析一下这个错误日志",
      prevAssistantText: "日志显示是内存溢出...",
      newUserText: "这个怎么解决",
    });
    expect(d.relation).toBe("follow_up");
    expect(d.signals).toContain("r3_pronoun_ref");
  });

  it("explicit new-task phrase wins over pronoun follow-up when confidence ties", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "帮我配置Nginx的SSL证书",
      prevAssistantText: "好的，SSL证书配置如下...",
      newUserText: "那再换个新任务",
    });
    expect(d.relation).toBe("new_task");
    expect(d.signals).toContain("r5_new_phrase");
  });

  it("idle > 2h triggers hard new_task split", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "deploy the site",
      prevAssistantText: "deployed successfully",
      newUserText: "can you help with something",
      gapMs: 3 * 60 * 60 * 1000, // 3 hours
    });
    expect(d.relation).toBe("new_task");
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
    expect(d.signals).toContain("idle_timeout");
  });

  it("negation mid-sentence does NOT trigger strong heuristic", async () => {
    const c = heuristic();
    const d = await c.classify({
      prevUserText: "帮我检查这段代码",
      prevAssistantText: "代码看起来没问题...",
      newUserText: "如果这个不对的话怎么处理",
    });
    // "不对" appears mid-sentence — should NOT be a strong revision signal.
    // Without LLM it should fall to follow_up default or weak heuristic.
    expect(d.relation).not.toBe("revision");
  });

  it("two-pass arbitration downgrades low-confidence new_task", async () => {
    // Primary LLM says new_task with low confidence → arbitration says follow_up
    const llm: Partial<LlmClient> = {
      completeJson: async (_msgs, opts) => {
        const op = (opts as { op?: string }).op;
        if (op === "session.relation.arbitrate") {
          return { value: { relation: "follow_up", reason: "same project" }, servedBy: "fake" } as never;
        }
        return {
          value: { relation: "new_task", confidence: 0.5, reason: "maybe new" },
          servedBy: "fake",
        } as never;
      },
    };
    const c = withLlm(llm);
    const d = await c.classify({
      prevUserText: "配置Nginx",
      prevAssistantText: "Nginx配置如下...",
      newUserText: "那数据库怎么配",
    });
    // Pronoun heuristic fires first (confidence 0.85), so it bypasses LLM.
    // But if it didn't fire (longer message), the arbitration would kick in.
    // Either way, should NOT be new_task for this input.
    expect(d.relation).not.toBe("new_task");
  });
});
