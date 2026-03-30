import { describe, it, expect } from "vitest";
import {
  type AgentMessage,
  type SearchHit,
  getTextFromMessage,
  appendMemoryToMessage,
  removeExistingMemoryBlock,
  messageHasMemoryBlock,
  formatMemoryBlock,
  deduplicateHits,
  insertSyntheticAssistantEntry,
  findTargetAssistantEntry,
} from "../src/context-engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(role: string, text: string): AgentMessage {
  return { role, content: [{ type: "text", text }], timestamp: Date.now() };
}

function makeStringMsg(role: string, text: string): AgentMessage {
  return { role, content: text, timestamp: Date.now() };
}

function makeHit(overrides?: Partial<SearchHit>): SearchHit {
  return {
    score: 0.85,
    summary: "test memory summary",
    original_excerpt: "test memory excerpt content",
    source: { role: "user", ts: Date.now(), sessionKey: "s1" },
    ref: { chunkId: "c1", sessionKey: "s1", turnId: "t1", seq: 0 },
    taskId: null,
    skillId: null,
    origin: "local",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getTextFromMessage
// ---------------------------------------------------------------------------

describe("getTextFromMessage", () => {
  it("extracts text from string content", () => {
    const msg = makeStringMsg("assistant", "hello world");
    expect(getTextFromMessage(msg)).toBe("hello world");
  });

  it("extracts text from content block array", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "part one" },
        { type: "image", url: "http://..." },
        { type: "text", text: "part two" },
      ],
    };
    expect(getTextFromMessage(msg)).toBe("part onepart two");
  });

  it("returns empty string for non-text content", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "image", url: "http://..." }],
    };
    expect(getTextFromMessage(msg)).toBe("");
  });

  it("returns empty string for undefined content", () => {
    const msg: AgentMessage = { role: "assistant", content: "" };
    expect(getTextFromMessage(msg)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// appendMemoryToMessage
// ---------------------------------------------------------------------------

describe("appendMemoryToMessage", () => {
  it("appends to string content", () => {
    const msg = makeStringMsg("assistant", "response text");
    appendMemoryToMessage(msg, "\n<relevant-memories>\nmem\n</relevant-memories>");
    expect(msg.content).toBe(
      "response text\n<relevant-memories>\nmem\n</relevant-memories>",
    );
  });

  it("appends to last text block in content array", () => {
    const msg = makeMsg("assistant", "response text");
    appendMemoryToMessage(msg, "\n<relevant-memories>\nmem\n</relevant-memories>");
    const blocks = msg.content as Array<{ type: string; text?: string }>;
    expect(blocks[0].text).toBe(
      "response text\n<relevant-memories>\nmem\n</relevant-memories>",
    );
  });

  it("creates a new text block if none exist", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "image", url: "http://..." }],
    };
    appendMemoryToMessage(msg, "\n<relevant-memories>\nmem\n</relevant-memories>");
    const blocks = msg.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].text).toContain("<relevant-memories>");
  });

  it("handles empty content by setting it", () => {
    const msg: AgentMessage = { role: "assistant", content: undefined as any };
    appendMemoryToMessage(msg, "memory");
    expect(msg.content).toBe("memory");
  });
});

// ---------------------------------------------------------------------------
// removeExistingMemoryBlock
// ---------------------------------------------------------------------------

describe("removeExistingMemoryBlock", () => {
  it("removes memory block from string content", () => {
    const msg = makeStringMsg(
      "assistant",
      "response text\n<relevant-memories>\nsome memories\n</relevant-memories>",
    );
    removeExistingMemoryBlock(msg);
    expect(msg.content).toBe("response text");
  });

  it("removes memory block from content block array", () => {
    const msg = makeMsg(
      "assistant",
      "response text\n<relevant-memories>\nsome memories\n</relevant-memories>",
    );
    removeExistingMemoryBlock(msg);
    const blocks = msg.content as Array<{ type: string; text: string }>;
    expect(blocks[0].text).toBe("response text");
  });

  it("handles message without memory block (no-op)", () => {
    const msg = makeMsg("assistant", "clean response");
    removeExistingMemoryBlock(msg);
    expect(getTextFromMessage(msg)).toBe("clean response");
  });

  it("removes multiple memory blocks", () => {
    const msg = makeStringMsg(
      "assistant",
      "text\n<relevant-memories>\nmem1\n</relevant-memories>\nmore\n<relevant-memories>\nmem2\n</relevant-memories>",
    );
    removeExistingMemoryBlock(msg);
    expect(msg.content).toBe("text\nmore");
  });
});

// ---------------------------------------------------------------------------
// messageHasMemoryBlock
// ---------------------------------------------------------------------------

describe("messageHasMemoryBlock", () => {
  it("returns true when memory block exists", () => {
    const msg = makeMsg(
      "assistant",
      "text\n<relevant-memories>\nmem\n</relevant-memories>",
    );
    expect(messageHasMemoryBlock(msg)).toBe(true);
  });

  it("returns false when no memory block", () => {
    const msg = makeMsg("assistant", "clean text");
    expect(messageHasMemoryBlock(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatMemoryBlock
// ---------------------------------------------------------------------------

describe("formatMemoryBlock", () => {
  it("formats hits into a memory block with tags", () => {
    const hits: SearchHit[] = [
      makeHit({ source: { role: "user" }, original_excerpt: "user said hello" }),
      makeHit({ source: { role: "assistant" }, original_excerpt: "bot replied hi" }),
    ];
    const block = formatMemoryBlock(hits);
    expect(block).toContain("<relevant-memories>");
    expect(block).toContain("</relevant-memories>");
    expect(block).toContain("1. [user] user said hello");
    expect(block).toContain("2. [assistant] bot replied hi");
    expect(block).toContain("not part of assistant's original reply");
  });

  it("truncates excerpts at 200 chars", () => {
    const longExcerpt = "x".repeat(300);
    const hits = [makeHit({ original_excerpt: longExcerpt })];
    const block = formatMemoryBlock(hits);
    const match = block.match(/1\. \[user\] (x+)/);
    expect(match).toBeTruthy();
    expect(match![1].length).toBe(200);
  });

  it("falls back to summary when excerpt is missing", () => {
    const hits = [
      makeHit({ original_excerpt: undefined, summary: "summary fallback" }),
    ];
    const block = formatMemoryBlock(hits);
    expect(block).toContain("summary fallback");
  });
});

// ---------------------------------------------------------------------------
// deduplicateHits
// ---------------------------------------------------------------------------

describe("deduplicateHits", () => {
  it("removes near-duplicate hits by summary overlap", () => {
    const hits = [
      { summary: "the quick brown fox jumps over the lazy dog", score: 0.9 },
      { summary: "the quick brown fox jumps over a lazy dog", score: 0.8 },
      { summary: "completely different summary about cats", score: 0.7 },
    ];
    const result = deduplicateHits(hits);
    expect(result).toHaveLength(2);
    expect(result[0].score).toBe(0.9);
    expect(result[1].summary).toContain("cats");
  });

  it("keeps all hits when no duplicates", () => {
    const hits = [
      { summary: "alpha beta gamma", score: 0.9 },
      { summary: "delta epsilon zeta", score: 0.8 },
    ];
    expect(deduplicateHits(hits)).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(deduplicateHits([])).toHaveLength(0);
  });

  it("handles exact duplicate summaries", () => {
    const hits = [
      { summary: "exactly the same", score: 0.9 },
      { summary: "exactly the same", score: 0.7 },
    ];
    expect(deduplicateHits(hits)).toHaveLength(1);
    expect(deduplicateHits(hits)[0].score).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// SessionManager mock for insertSyntheticAssistantEntry and findTargetAssistantEntry
// ---------------------------------------------------------------------------

class MockSessionManager {
  private entries: Array<{
    id: string;
    type: string;
    parentId?: string | null;
    message?: AgentMessage;
    [key: string]: unknown;
  }> = [];
  private nextId = 1;
  private branchedFrom: string | null = null;
  public appendedMessages: unknown[] = [];

  addEntry(type: string, message?: AgentMessage, parentId?: string | null) {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ id, type, parentId: parentId ?? null, message });
    return id;
  }

  getBranch() {
    return [...this.entries];
  }

  branch(parentId: string) {
    this.branchedFrom = parentId;
    this.entries = [];
    this.nextId = 100;
  }

  resetLeaf() {
    this.branchedFrom = "__root__";
    this.entries = [];
    this.nextId = 100;
  }

  appendMessage(msg: unknown): string {
    const id = `entry-${this.nextId++}`;
    this.entries.push({
      id,
      type: "message",
      parentId: null,
      message: msg as AgentMessage,
    });
    this.appendedMessages.push(msg);
    return id;
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: unknown,
  ): string {
    const id = `entry-${this.nextId++}`;
    this.entries.push({
      id,
      type: "compaction",
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    });
    return id;
  }

  appendThinkingLevelChange(level: string): string {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ id, type: "thinking_level_change", thinkingLevel: level });
    return id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ id, type: "model_change", provider, modelId });
    return id;
  }

  appendCustomEntry(customType: string, data: unknown): string {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ id, type: "custom", customType, data });
    return id;
  }

  appendCustomMessageEntry(
    customType: string,
    content: unknown,
    display: unknown,
    details?: unknown,
  ): string {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ id, type: "custom_message", customType, content, display, details });
    return id;
  }

  appendSessionInfo(name: string): string {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ id, type: "session_info", name });
    return id;
  }

  branchWithSummary(
    parentId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: unknown,
  ): string {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ id, type: "branch_summary", parentId, summary, details, fromHook });
    return id;
  }

  appendLabelChange(targetId: string, label: string): string {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ id, type: "label_change", targetId, label });
    return id;
  }

  getBranchedFrom() {
    return this.branchedFrom;
  }
}

// ---------------------------------------------------------------------------
// insertSyntheticAssistantEntry
// ---------------------------------------------------------------------------

describe("insertSyntheticAssistantEntry", () => {
  it("inserts synthetic assistant before existing entries", () => {
    const sm = new MockSessionManager();
    sm.addEntry("message", makeMsg("user", "hello"), null);
    sm.addEntry("message", makeMsg("assistant", "hi there"));

    const memBlock =
      "\n<relevant-memories>\n[Memory context]\n1. test mem\n</relevant-memories>";
    const ok = insertSyntheticAssistantEntry(sm as any, memBlock);

    expect(ok).toBe(true);
    const branch = sm.getBranch();
    expect(branch).toHaveLength(3);
    expect(branch[0].type).toBe("message");
    expect(branch[0].message?.role).toBe("assistant");
    expect(getTextFromMessage(branch[0].message!)).toContain("<relevant-memories>");
    expect(branch[1].message?.role).toBe("user");
    expect(branch[2].message?.role).toBe("assistant");
  });

  it("returns false for empty branch", () => {
    const sm = new MockSessionManager();
    const ok = insertSyntheticAssistantEntry(sm as any, "mem");
    expect(ok).toBe(false);
  });

  it("preserves non-message entries during reappend", () => {
    const sm = new MockSessionManager();
    sm.addEntry("message", makeMsg("user", "hello"), "root-id");
    sm.addEntry("thinking_level_change", undefined);
    (sm.getBranch()[1] as any).thinkingLevel = "high";
    sm.addEntry("message", makeMsg("assistant", "response"));

    const ok = insertSyntheticAssistantEntry(sm as any, "mem");
    expect(ok).toBe(true);

    const branch = sm.getBranch();
    expect(branch.length).toBeGreaterThanOrEqual(3);
    const types = branch.map((e) => e.type);
    expect(types[0]).toBe("message");
    expect(types).toContain("thinking_level_change");
  });

  it("calls resetLeaf when first entry has no parentId", () => {
    const sm = new MockSessionManager();
    sm.addEntry("message", makeMsg("user", "hello"), null);

    insertSyntheticAssistantEntry(sm as any, "mem");
    expect(sm.getBranchedFrom()).toBe("__root__");
  });

  it("calls branch with parentId when first entry has one", () => {
    const sm = new MockSessionManager();
    sm.addEntry("message", makeMsg("user", "hello"), "parent-123");

    insertSyntheticAssistantEntry(sm as any, "mem");
    expect(sm.getBranchedFrom()).toBe("parent-123");
  });
});

// ---------------------------------------------------------------------------
// findTargetAssistantEntry
// ---------------------------------------------------------------------------

describe("findTargetAssistantEntry", () => {
  it("finds last assistant before last user", () => {
    const branch = [
      { id: "e1", type: "message", message: makeMsg("user", "q1") },
      { id: "e2", type: "message", message: makeMsg("assistant", "a1") },
      { id: "e3", type: "message", message: makeMsg("user", "q2") },
    ];
    const target = findTargetAssistantEntry(branch);
    expect(target).not.toBeNull();
    expect(target!.id).toBe("e2");
  });

  it("returns null when no assistant before user", () => {
    const branch = [
      { id: "e1", type: "message", message: makeMsg("user", "q1") },
    ];
    expect(findTargetAssistantEntry(branch)).toBeNull();
  });

  it("returns null for empty branch", () => {
    expect(findTargetAssistantEntry([])).toBeNull();
  });

  it("skips non-message entries", () => {
    const branch = [
      { id: "e1", type: "message", message: makeMsg("assistant", "a0") },
      { id: "e2", type: "compaction", summary: "compacted" },
      { id: "e3", type: "message", message: makeMsg("user", "q1") },
      { id: "e4", type: "message", message: makeMsg("assistant", "a1") },
      { id: "e5", type: "message", message: makeMsg("user", "q2") },
    ];
    const target = findTargetAssistantEntry(branch);
    expect(target!.id).toBe("e4");
  });

  it("picks the immediate assistant before the last user, not an earlier one", () => {
    const branch = [
      { id: "e1", type: "message", message: makeMsg("assistant", "a0") },
      { id: "e2", type: "message", message: makeMsg("user", "q1") },
      { id: "e3", type: "message", message: makeMsg("assistant", "a1") },
      { id: "e4", type: "message", message: makeMsg("assistant", "a2") },
      { id: "e5", type: "message", message: makeMsg("user", "q2") },
    ];
    const target = findTargetAssistantEntry(branch);
    expect(target!.id).toBe("e4");
  });
});

// ---------------------------------------------------------------------------
// Integration: full injection + removal cycle
// ---------------------------------------------------------------------------

describe("injection cycle integration", () => {
  it("inject → detect → remove → re-inject produces clean result", () => {
    const msg = makeMsg("assistant", "original response");

    const mem1 = formatMemoryBlock([
      makeHit({ original_excerpt: "user likes cats" }),
    ]);
    appendMemoryToMessage(msg, mem1);
    expect(messageHasMemoryBlock(msg)).toBe(true);
    expect(getTextFromMessage(msg)).toContain("user likes cats");

    removeExistingMemoryBlock(msg);
    expect(messageHasMemoryBlock(msg)).toBe(false);
    expect(getTextFromMessage(msg)).toBe("original response");

    const mem2 = formatMemoryBlock([
      makeHit({ original_excerpt: "user likes dogs" }),
    ]);
    appendMemoryToMessage(msg, mem2);
    expect(messageHasMemoryBlock(msg)).toBe(true);
    expect(getTextFromMessage(msg)).toContain("user likes dogs");
    expect(getTextFromMessage(msg)).not.toContain("user likes cats");
  });

  it("works with string content messages", () => {
    const msg = makeStringMsg("assistant", "string response");
    const mem = formatMemoryBlock([makeHit({ original_excerpt: "mem1" })]);

    appendMemoryToMessage(msg, mem);
    expect(messageHasMemoryBlock(msg)).toBe(true);

    removeExistingMemoryBlock(msg);
    expect(msg.content).toBe("string response");
    expect(messageHasMemoryBlock(msg)).toBe(false);
  });
});
