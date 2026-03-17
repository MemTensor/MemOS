import { describe, it, expect } from "vitest";
import { captureMessages } from "../src/capture";
import type { Logger } from "../src/types";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("captureMessages", () => {
  it("should keep user and assistant messages as-is", () => {
    const msgs = [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there" },
    ];
    const result = captureMessages(msgs, "s1", "t1", "STORED_MEMORY", noopLog);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("Hello world");
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toBe("Hi there");
  });

  it("should filter system messages and self-tool results", () => {
    const msgs = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "tool", content: '{"hits":[]}', toolName: "memory_search" },
      { role: "user", content: "Hello" },
    ];
    const result = captureMessages(msgs, "s1", "t1", "STORED_MEMORY", noopLog);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("should keep non-self tool messages with original content", () => {
    const msgs = [
      { role: "tool", content: '{"result": "ok"}', toolName: "web_search" },
      { role: "user", content: "Hello" },
    ];
    const result = captureMessages(msgs, "s1", "t1", "STORED_MEMORY", noopLog);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("tool");
    expect(result[0].content).toBe('{"result": "ok"}');
    expect(result[0].toolName).toBe("web_search");
  });

  it("should strip explicit evidence wrapper blocks from assistant messages", () => {
    const msgs = [
      {
        role: "assistant",
        content: "Based on memory: [STORED_MEMORY]some evidence[/STORED_MEMORY] the answer is 42.",
      },
    ];
    const result = captureMessages(msgs, "s1", "t1", "STORED_MEMORY", noopLog);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Based on memory: the answer is 42.");
  });

  it("should not strip ordinary mentions of the evidence tag", () => {
    const msgs = [
      {
        role: "assistant",
        content: "The literal token STORED_MEMORY appears in this docs note.",
      },
    ];

    const result = captureMessages(msgs, "s1", "t1", "STORED_MEMORY", noopLog);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("The literal token STORED_MEMORY appears in this docs note.");
  });

  it("should skip empty messages", () => {
    const msgs = [
      { role: "user", content: "" },
      { role: "assistant", content: "   " },
      { role: "user", content: "Real message" },
    ];
    const result = captureMessages(msgs, "s1", "t1", "STORED_MEMORY", noopLog);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Real message");
  });

  it("should skip all memory tool variants", () => {
    const msgs = [
      { role: "tool", content: "search results", toolName: "memory_search" },
      { role: "tool", content: "timeline data", toolName: "memory_timeline" },
      { role: "tool", content: "chunk data", toolName: "memory_get" },
      { role: "tool", content: "viewer url", toolName: "memory_viewer" },
      { role: "tool", content: "other tool result", toolName: "bash" },
    ];
    const result = captureMessages(msgs, "s1", "t1", "STORED_MEMORY", noopLog);
    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe("bash");
  });

  it("should strip OpenClaw inbound metadata from user messages", () => {
    const rawContent = [
      "Sender (untrusted metadata):",
      "```json",
      "{",
      '  "label": "openclaw-control-ui",',
      '  "id": "openclaw-control-ui"',
      "}",
      "```",
      "",
      "  [Tue 2026-03-03 21:58 GMT+8] 我的职业是啥",
    ].join("\n");

    const msgs = [{ role: "user", content: rawContent }];
    const result = captureMessages(msgs, "s1", "t1", "STORED_MEMORY", noopLog);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("我的职业是啥");
  });

  it("should strip multiple metadata blocks", () => {
    const rawContent = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{ "channel": "webchat" }',
      "```",
      "Sender (untrusted metadata):",
      "```json",
      '{ "label": "user1", "id": "u1" }',
      "```",
      "",
      "[Mon 2026-03-03 20:00 GMT+8] 你好",
    ].join("\n");

    const msgs = [{ role: "user", content: rawContent }];
    const result = captureMessages(msgs, "s1", "t1", "STORED_MEMORY", noopLog);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("你好");
  });

  it("should not strip from assistant or tool messages", () => {
    const msgs = [
      { role: "assistant", content: "Sender (untrusted metadata):\nsome text" },
    ];
    const result = captureMessages(msgs, "s1", "t1", "STORED_MEMORY", noopLog);
    expect(result[0].content).toBe("Sender (untrusted metadata):\nsome text");
  });

  it("should handle user message without metadata prefix", () => {
    const msgs = [{ role: "user", content: "普通的用户消息" }];
    const result = captureMessages(msgs, "s1", "t1", "STORED_MEMORY", noopLog);
    expect(result[0].content).toBe("普通的用户消息");
  });
});
