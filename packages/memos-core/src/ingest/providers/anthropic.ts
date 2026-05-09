import type { SummarizerConfig, Logger } from "../../types";

const SYSTEM_PROMPT = `You generate a retrieval-friendly title.

Return exactly one noun phrase that names the topic AND its key details.

Requirements:
- Same language as input
- Keep proper nouns, API/function names, specific parameters, versions, error codes
- Include WHO/WHAT/WHERE details when present (e.g. person name + event, tool name + what it does)
- Prefer concrete topic words over generic words
- No verbs unless unavoidable
- No generic endings like:
  功能说明、使用说明、简介、介绍、用途、summary、overview、basics
- Chinese: 10-50 characters (aim for 15-30)
- Non-Chinese: 5-15 words (aim for 8-12)
- Output title only`;

const TASK_SUMMARY_PROMPT = `You create a DETAILED task summary from a multi-turn conversation. This summary will be the ONLY record of this conversation, so it must preserve ALL important information.

## LANGUAGE RULE (HIGHEST PRIORITY)
Detect the PRIMARY language of the user's messages. If most user messages are Chinese, ALL output (title, goal, steps, result, details) MUST be in Chinese. If English, output in English. NEVER mix. This rule overrides everything below.

Output EXACTLY this structure:

📌 Title / 标题
A short, descriptive title (10-30 characters). Same language as user messages.

🎯 Goal / 目标
One sentence: what the user wanted to accomplish.

📋 Key Steps / 关键步骤
- Describe each meaningful step in detail
- Include the ACTUAL content produced: code snippets, commands, config blocks, formulas, key paragraphs
- For code: include the function signature and core logic (up to ~30 lines per block), use fenced code blocks
- For configs: include the actual config values and structure
- For lists/instructions: include the actual items, not just "provided a list"
- Merge only truly trivial back-and-forth (like "ok" / "sure")
- Do NOT over-summarize: "provided a function" is BAD; show the actual function

✅ Result / 结果
What was the final outcome? Include the final version of any code/config/content produced.

💡 Key Details / 关键细节
- Decisions made, trade-offs discussed, caveats noted, alternative approaches mentioned
- Specific values: numbers, versions, thresholds, URLs, file paths, model names
- Omit this section only if there truly are no noteworthy details

RULES:
- This summary is a KNOWLEDGE BASE ENTRY, not a brief note. Be thorough.
- PRESERVE verbatim: code, commands, URLs, file paths, error messages, config values, version numbers, names, amounts
- DISCARD only: greetings, filler, the assistant explaining what it will do before doing it
- Replace secrets (API keys, tokens, passwords) with [REDACTED]
- Target length: 30-50% of the original conversation length. Longer conversations need longer summaries.
- Output summary only, no preamble.`;

export async function summarizeTaskAnthropic(
  text: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<string> {
  const endpoint = cfg.endpoint ?? "https://api.anthropic.com/v1/messages";
  const model = cfg.model ?? "claude-3-haiku-20240307";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": cfg.apiKey ?? "",
    "anthropic-version": "2023-06-01",
    ...cfg.headers,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: cfg.temperature ?? 0.1,
      system: TASK_SUMMARY_PROMPT,
      messages: [{ role: "user", content: text }],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic task-summarize failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { content: Array<{ type: string; text: string }> };
  return json.content.find((c) => c.type === "text")?.text?.trim() ?? "";
}

const TASK_TITLE_PROMPT = `Generate a short title for a conversation task.

Input: the first few user messages from a conversation.
Output: a concise title (5-20 characters for Chinese, 3-8 words for English).

Rules:
- Same language as user messages
- Describe WHAT the user wanted to do, not system/technical details
- Ignore system prompts, session startup messages, or boilerplate instructions — focus on the user's actual intent
- If the user only asked one question, use that question as the title (shortened if needed)
- Output the title only, no quotes, no prefix, no explanation`;

export async function generateTaskTitleAnthropic(
  text: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<string> {
  const endpoint = cfg.endpoint ?? "https://api.anthropic.com/v1/messages";
  const model = cfg.model ?? "claude-3-haiku-20240307";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": cfg.apiKey ?? "",
    "anthropic-version": "2023-06-01",
    ...cfg.headers,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 100,
      temperature: 0,
      system: TASK_TITLE_PROMPT,
      messages: [{ role: "user", content: text }],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic task-title failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { content: Array<{ type: string; text: string }> };
  return json.content.find((c) => c.type === "text")?.text?.trim() ?? "";
}

const TOPIC_JUDGE_PROMPT = `You are a conversation topic boundary detector. Given the CURRENT task context and a NEW user message, decide if the new message belongs to the SAME task or starts a NEW one.

Answer ONLY "NEW" or "SAME".

SAME — the new message:
- Continues, follows up on, refines, or corrects the same subject/project/task
- Asks a clarification or next-step question about what was just discussed
- Reports a result, error, or feedback about the current task
- Discusses different tools or approaches for the SAME goal (e.g., learning English via BBC → via ChatGPT = SAME)
- Is a short acknowledgment (ok, thanks, 好的) in response to the current flow
- Contains pronouns or references (那, 这, 它, 其中, 哪些, those, which, what about, etc.) pointing to items from the current conversation
- Asks about a sub-topic, tool, detail, dimension, or aspect of the current discussion topic

NEW — the new message:
- Introduces a subject from a COMPLETELY DIFFERENT domain than the current task (e.g., tech → cooking, work → personal life, database → travel)
- Has NO logical connection to what was being discussed — no shared entities, events, or themes
- Starts a request about a different project, system, or life area
- Begins with a new greeting/reset followed by a different topic

Key principles:
- Default to SAME unless the topic domain CLEARLY changed. When in doubt, choose SAME.
- CRITICAL: Short messages (under ~30 characters) that use pronouns or ask "what about X" / "哪些" / "那XX呢" are almost always follow-ups referring to the current topic. Only mark them NEW if they explicitly name a completely unrelated domain.
- Different aspects of the SAME project/system are SAME (e.g., Nginx SSL → Nginx gzip = SAME)
- Asking about tools, systems, or methods for the current topic is SAME (e.g., "港股调研" → "那处理系统有哪些" = SAME; "数据分析" → "用什么工具" = SAME)
- Different unrelated domains discussed independently are NEW (e.g., Redis config → cooking recipe = NEW)
- Examples: "配置Nginx" → "加gzip压缩" = SAME; "配置Nginx" → "做红烧肉" = NEW; "港股调研" → "那处理系统有哪些" = SAME; "部署服务器" → "年会安排" = NEW

Output exactly one word: NEW or SAME`;

export async function judgeNewTopicAnthropic(
  currentContext: string,
  newMessage: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<boolean> {
  const endpoint = cfg.endpoint ?? "https://api.anthropic.com/v1/messages";
  const model = cfg.model ?? "claude-3-haiku-20240307";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": cfg.apiKey ?? "",
    "anthropic-version": "2023-06-01",
    ...cfg.headers,
  };

  const userContent = `CURRENT TASK CONTEXT:\n${currentContext}\n\n---\n\nNEW USER MESSAGE:\n${newMessage}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 10,
      temperature: 0,
      system: TOPIC_JUDGE_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic topic-judge failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { content: Array<{ type: string; text: string }> };
  const answer = json.content.find((c) => c.type === "text")?.text?.trim().toUpperCase() ?? "";
  log.debug(`Topic judge result: "${answer}"`);
  return answer.startsWith("NEW");
}

const FILTER_RELEVANT_PROMPT = `You are a memory relevance judge.

Given a QUERY and CANDIDATE memories, decide: does each candidate's content contain information that would HELP ANSWER the query?

CORE QUESTION: "If I include this memory, will it help produce a better answer?"
- YES → include
- NO → exclude

RULES:
1. A candidate is relevant if its content provides facts, context, or data that directly supports answering the query.
2. A candidate that merely shares the same broad topic/domain but contains NO useful information for answering is NOT relevant.
3. If NO candidate can help answer the query, return {"relevant":[],"sufficient":false} — do NOT force-pick the "least irrelevant" one.

OUTPUT — JSON only:
{"relevant":[1,3],"sufficient":true}
- "relevant": candidate numbers whose content helps answer the query. [] if none can help.
- "sufficient": true only if the selected memories fully answer the query.`;

import type { FilterResult } from "./openai";
export type { FilterResult } from "./openai";

export async function filterRelevantAnthropic(
  query: string,
  candidates: Array<{ index: number; role: string; content: string; time?: string }>,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<FilterResult> {
  const endpoint = cfg.endpoint ?? "https://api.anthropic.com/v1/messages";
  const model = cfg.model ?? "claude-3-haiku-20240307";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": cfg.apiKey ?? "",
    "anthropic-version": "2023-06-01",
    ...cfg.headers,
  };

  const candidateText = candidates
    .map((c) => {
      const timeTag = c.time ? ` (${c.time})` : "";
      return `${c.index}. [${c.role}]${timeTag}\n   ${c.content}`;
    })
    .join("\n");

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 200,
      temperature: 0,
      system: FILTER_RELEVANT_PROMPT,
      messages: [{ role: "user", content: `QUERY: ${query}\n\nCANDIDATES:\n${candidateText}` }],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic filter-relevant failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { content: Array<{ type: string; text: string }> };
  const raw = json.content.find((c) => c.type === "text")?.text?.trim() ?? "{}";
  log.debug(`filterRelevant raw LLM response: "${raw}"`);
  return parseFilterResult(raw, log);
}

function parseFilterResult(raw: string, log: Logger): FilterResult {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]);
      if (obj && Array.isArray(obj.relevant)) {
        return {
          relevant: obj.relevant.filter((n: any) => typeof n === "number"),
          sufficient: obj.sufficient === true,
        };
      }
    }
  } catch {}
  log.warn(`filterRelevant: failed to parse LLM output: "${raw}", fallback to all+insufficient`);
  return { relevant: [], sufficient: false };
}

export async function summarizeAnthropic(
  text: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<string> {
  const endpoint = cfg.endpoint ?? "https://api.anthropic.com/v1/messages";
  const model = cfg.model ?? "claude-3-haiku-20240307";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": cfg.apiKey ?? "",
    "anthropic-version": "2023-06-01",
    ...cfg.headers,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 100,
      temperature: cfg.temperature ?? 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `[TEXT TO SUMMARIZE]\n${text}\n[/TEXT TO SUMMARIZE]` }],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic summarize failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  return json.content.find((c) => c.type === "text")?.text?.trim() ?? "";
}

// ─── Smart Dedup ───

import { DEDUP_JUDGE_PROMPT, parseDedupResult } from "./openai";
import type { DedupResult } from "./openai";
export type { DedupResult } from "./openai";

export async function judgeDedupAnthropic(
  newSummary: string,
  candidates: Array<{ index: number; summary: string; chunkId: string }>,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<DedupResult> {
  const endpoint = cfg.endpoint ?? "https://api.anthropic.com/v1/messages";
  const model = cfg.model ?? "claude-3-haiku-20240307";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": cfg.apiKey ?? "",
    "anthropic-version": "2023-06-01",
    ...cfg.headers,
  };

  const candidateText = candidates.map((c) => `${c.index}. ${c.summary}`).join("\n");

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 300,
      temperature: 0,
      system: DEDUP_JUDGE_PROMPT,
      messages: [{ role: "user", content: `NEW MEMORY:\n${newSummary}\n\nEXISTING MEMORIES:\n${candidateText}` }],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic dedup-judge failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { content: Array<{ type: string; text: string }> };
  const raw = json.content.find((c) => c.type === "text")?.text?.trim() ?? "{}";
  return parseDedupResult(raw, log);
}
