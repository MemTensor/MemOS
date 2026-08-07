import { describe, expect, it, vi } from "vitest";
import { buildTopicJudgeContext, topicJudgePreFilter } from "../src/recall/topic-judge";
import type { Logger } from "../src/types";

const log: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const conversation = [
  { role: "user", content: "How do I configure retries?" },
  { role: "assistant", content: "Set maxRetries in the client config." },
];

function makeSummarizer(result: boolean | null) {
  return { judgeNewTopic: vi.fn().mockResolvedValue(result) };
}

describe("topicJudgePreFilter", () => {
  it("is disabled at zero rounds", async () => {
    const summarizer = makeSummarizer(false);

    await expect(topicJudgePreFilter({
      messages: conversation,
      query: "Can you show an example?",
      topicJudgeRounds: 0,
      summarizer,
      log,
    })).resolves.toBe("proceed");
    expect(summarizer.judgeNewTopic).not.toHaveBeenCalled();
  });

  it("treats non-finite round configuration as disabled", async () => {
    const summarizer = makeSummarizer(false);

    await expect(topicJudgePreFilter({
      messages: conversation,
      query: "Can you show an example?",
      topicJudgeRounds: Number.NaN,
      summarizer,
      log,
    })).resolves.toBe("proceed");
    expect(summarizer.judgeNewTopic).not.toHaveBeenCalled();
  });

  it("bypasses topic classification for a new session", async () => {
    const summarizer = makeSummarizer(false);

    await expect(topicJudgePreFilter({
      messages: conversation,
      query: "Can you show an example?",
      topicJudgeRounds: 4,
      isNewSession: true,
      summarizer,
      log,
    })).resolves.toBe("proceed");
    expect(summarizer.judgeNewTopic).not.toHaveBeenCalled();
  });

  it("skips recall for a SAME-topic decision", async () => {
    const summarizer = makeSummarizer(false);

    await expect(topicJudgePreFilter({
      messages: conversation,
      query: "Can you show an example?",
      topicJudgeRounds: 4,
      summarizer,
      log,
    })).resolves.toBe("skip");
  });

  it("proceeds with recall for a NEW-topic decision", async () => {
    const summarizer = makeSummarizer(true);

    await expect(topicJudgePreFilter({
      messages: conversation,
      query: "What is the deployment process?",
      topicJudgeRounds: 4,
      summarizer,
      log,
    })).resolves.toBe("proceed");
  });

  it("fails open when the classifier response cannot be parsed", async () => {
    const summarizer = makeSummarizer(null);

    await expect(topicJudgePreFilter({
      messages: conversation,
      query: "Can you show an example?",
      topicJudgeRounds: 4,
      summarizer,
      log,
    })).resolves.toBe("proceed");
  });

  it("fails open when topic classification throws", async () => {
    const summarizer = {
      judgeNewTopic: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    };

    await expect(topicJudgePreFilter({
      messages: conversation,
      query: "Can you show an example?",
      topicJudgeRounds: 4,
      summarizer,
      log,
    })).resolves.toBe("proceed");
  });

  it("fails open when context construction throws", async () => {
    const malformedMessage = Object.defineProperty({}, "role", {
      get() {
        throw new Error("invalid message");
      },
    });
    const summarizer = makeSummarizer(false);

    await expect(topicJudgePreFilter({
      messages: [malformedMessage],
      query: "Can you show an example?",
      topicJudgeRounds: 4,
      summarizer,
      log,
    })).resolves.toBe("proceed");
    expect(summarizer.judgeNewTopic).not.toHaveBeenCalled();
  });

  it("fails open when there is no completed conversation round", async () => {
    const summarizer = makeSummarizer(false);

    await expect(topicJudgePreFilter({
      messages: [{ role: "user", content: "Current prompt" }],
      query: "Current prompt",
      topicJudgeRounds: 4,
      summarizer,
      log,
    })).resolves.toBe("proceed");
    expect(summarizer.judgeNewTopic).not.toHaveBeenCalled();
  });
});

describe("buildTopicJudgeContext", () => {
  it("strips OpenClaw inbound metadata using the shared capture helper", () => {
    const context = buildTopicJudgeContext([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Sender (untrusted metadata):\n```json\n{\"id\":\"user-1\"}\n```\n\nHow do I configure retries?",
          },
        ],
      },
      { role: "assistant", content: "Set maxRetries in the client config." },
      { role: "tool", content: "internal tool output" },
    ], 4);

    expect(context).toContain("USER: How do I configure retries?");
    expect(context).toContain("ASSISTANT: Set maxRetries in the client config.");
    expect(context).not.toContain("untrusted metadata");
    expect(context).not.toContain("user-1");
    expect(context).not.toContain("internal tool output");
  });

  it("excludes a trailing user message because it is not a completed round", () => {
    const context = buildTopicJudgeContext([
      ...conversation,
      { role: "user", content: "Interrupted historical prompt" },
    ], 4);

    expect(context).toContain("USER: How do I configure retries?");
    expect(context).toContain("ASSISTANT: Set maxRetries in the client config.");
    expect(context).not.toContain("Interrupted historical prompt");
  });
});
