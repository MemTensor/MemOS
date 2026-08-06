import { stripInboundMetadata } from "../capture";
import type { Logger } from "../types";

export type TopicJudgeDecision = "skip" | "proceed";

interface TopicJudgeSummarizer {
  judgeNewTopic(currentContext: string, newMessage: string): Promise<boolean | null>;
}

interface TopicJudgeOptions {
  messages: unknown[] | undefined;
  query: string;
  topicJudgeRounds: number;
  summarizer: TopicJudgeSummarizer;
  log: Logger;
}

interface ConversationLine {
  role: "user" | "assistant";
  text: string;
}

const MAX_MESSAGES_TO_INSPECT = 20;
const MAX_CONTEXT_LINE_CHARS = 500;
const CONTEXT_EDGE_CHARS = 150;

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object"
        && block !== null
        && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join(" ")
    .trim();
}

function truncateContextLine(text: string): string {
  if (text.length <= MAX_CONTEXT_LINE_CHARS) return text;
  return `${text.slice(0, CONTEXT_EDGE_CHARS)}...${text.slice(-CONTEXT_EDGE_CHARS)}`;
}

/** Build completed user/assistant rounds without the current user prompt. */
export function buildTopicJudgeContext(
  messages: unknown[] | undefined,
  topicJudgeRounds: number,
): string | null {
  if (!Array.isArray(messages) || !Number.isFinite(topicJudgeRounds) || topicJudgeRounds <= 0) {
    return null;
  }

  const merged: ConversationLine[] = [];
  for (const value of messages.slice(-MAX_MESSAGES_TO_INSPECT)) {
    if (typeof value !== "object" || value === null) continue;
    const message = value as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;

    const text = extractText(message.content);
    if (!text) continue;

    const previous = merged.at(-1);
    if (previous?.role === message.role) {
      previous.text += `\n\n${text}`;
    } else {
      merged.push({ role: message.role, text });
    }
  }

  // OpenClaw commonly includes the current prompt as the final user message.
  if (merged.at(-1)?.role === "user") merged.pop();

  const maxLines = Math.floor(topicJudgeRounds) * 2;
  const completed = merged.slice(-maxLines);
  while (completed.length > 0 && completed[0].role !== "user") completed.shift();
  while (completed.length > 0 && completed.at(-1)?.role !== "assistant") completed.pop();

  const contextLines = completed.flatMap(({ role, text }) => {
    const cleaned = role === "user" ? stripInboundMetadata(text) : text.trim();
    if (!cleaned) return [];
    return [`${role === "user" ? "USER" : "ASSISTANT"}: ${truncateContextLine(cleaned)}`];
  });

  if (
    contextLines.length < 2
    || !contextLines.some((line) => line.startsWith("USER:"))
    || !contextLines.some((line) => line.startsWith("ASSISTANT:"))
  ) {
    return null;
  }

  return contextLines.join("\n");
}

/**
 * Skip auto-recall only when topic classification conclusively returns SAME.
 * Missing context, parse failures, and provider errors all fail open.
 */
export async function topicJudgePreFilter({
  messages,
  query,
  topicJudgeRounds,
  summarizer,
  log,
}: TopicJudgeOptions): Promise<TopicJudgeDecision> {
  if (topicJudgeRounds <= 0) return "proceed";

  const currentContext = buildTopicJudgeContext(messages, topicJudgeRounds);
  if (!currentContext) {
    log.debug("auto-recall: topic-judge has insufficient completed context; proceeding");
    return "proceed";
  }

  try {
    log.debug(`auto-recall: topic-judge evaluating ${currentContext.split("\n").length} context lines`);
    const isNewTopic = await summarizer.judgeNewTopic(currentContext, query);
    if (isNewTopic === false) return "skip";
    if (isNewTopic === true) return "proceed";

    log.warn("auto-recall: topic-judge returned no parseable decision; proceeding");
    return "proceed";
  } catch (error) {
    log.warn(`auto-recall: topic-judge failed (${String(error)}); proceeding`);
    return "proceed";
  }
}
