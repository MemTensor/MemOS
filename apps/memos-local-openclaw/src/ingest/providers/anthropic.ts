import type { SummarizerConfig, Logger } from "../../types";

const SYSTEM_PROMPT = `Summarize the text in ONE concise sentence (max 120 characters). IMPORTANT: Use the SAME language as the input text — if the input is Chinese, write Chinese; if English, write English. Preserve exact names, commands, error codes. No bullet points, no preamble — output only the sentence.`;

const TASK_SUMMARY_PROMPT = `You create a DETAILED task summary from a multi-turn conversation. This summary will be the ONLY record of this conversation, so it must preserve ALL important information.

CRITICAL LANGUAGE RULE: You MUST write in the SAME language as the user's messages. Chinese input → Chinese output. English input → English output. NEVER mix languages.

Output EXACTLY this structure:

📌 Title
A short, descriptive title (10-30 characters). Like a chat group name.

🎯 Goal
One sentence: what the user wanted to accomplish.

📋 Key Steps
- Describe each meaningful step in detail
- Include the ACTUAL content produced: code snippets, commands, config blocks, formulas, key paragraphs
- For code: include the function signature and core logic (up to ~30 lines per block), use fenced code blocks
- For configs: include the actual config values and structure
- For lists/instructions: include the actual items, not just "provided a list"
- Merge only truly trivial back-and-forth (like "ok" / "sure")
- Do NOT over-summarize: "provided a function" is BAD; show the actual function

✅ Result
What was the final outcome? Include the final version of any code/config/content produced.

💡 Key Details
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

const TOPIC_JUDGE_PROMPT = `You are a conversation topic boundary detector. Given the CURRENT task context (may include opening topic + recent exchanges) and a single NEW user message, decide if the new message belongs to the SAME task or starts a NEW one.

Answer ONLY "NEW" or "SAME".

SAME — the new message:
- Continues, follows up on, refines, or corrects the same subject/project/task
- Asks a clarification or next-step question about what was just discussed
- Reports a result, error, or feedback about the current task
- Discusses different tools, methods, or approaches for the SAME goal (e.g., learning English via BBC → via ChatGPT → via AI tools = all SAME "learning English" task)
- Mentions a related technology or platform in the context of the current goal
- Is a short acknowledgment (ok, thanks, 好的, 嗯) in direct response to the current flow

NEW — the new message:
- Introduces a clearly UNRELATED subject with NO logical connection to the current task
- The topic has ZERO overlap with any aspect of the current conversation (e.g., from "learning English" to "what's the weather tomorrow")
- Starts a request about a completely different domain or life area
- Begins with a new greeting/reset followed by a different topic

Key principles:
- STRONGLY lean toward SAME — only mark NEW for obvious, unambiguous topic shifts
- Different aspects, tools, or methods related to the same overall goal are SAME
- If the new message could reasonably be interpreted as part of the ongoing discussion, choose SAME
- Only choose NEW when there is absolutely no thematic connection to the current task
- Examples: "学英语" → "用AI工具学英语" = SAME; "学英语" → "明天天气" = NEW

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

const FILTER_RELEVANT_PROMPT = `You are a memory relevance judge. Given a user's QUERY and a list of CANDIDATE memory summaries, do two things:

1. Select ALL candidates that could be useful for answering the query. When in doubt, INCLUDE the candidate.
   - For questions about lists, history, or "what/where/who" across multiple items (e.g. "which companies did I work at"), include ALL matching items — do NOT stop at the first match.
   - For factual lookups (e.g. "what is the SSH port"), a single direct answer is enough.
2. Judge whether the selected memories are SUFFICIENT to fully answer the query WITHOUT fetching additional context.

IMPORTANT for "sufficient" judgment:
- sufficient=true ONLY when the memories contain a concrete ANSWER, fact, decision, or actionable information that directly addresses the query.
- sufficient=false when:
  - The memories only repeat the same question the user asked before (echo, not answer).
  - The memories show related topics but lack the specific detail needed.
  - The memories contain partial information that would benefit from full task context, timeline, or related skills.

Output a JSON object with exactly two fields:
{"relevant":[1,3,5],"sufficient":true}

- "relevant": array of candidate numbers that are useful. Empty array [] if none are relevant.
- "sufficient": true ONLY if the memories contain a direct answer; false otherwise.

Output ONLY the JSON object, nothing else.`;

import type { FilterResult } from "./openai";
export type { FilterResult } from "./openai";

export async function filterRelevantAnthropic(
  query: string,
  candidates: Array<{ index: number; summary: string; role: string }>,
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
    .map((c) => `${c.index}. [${c.role}] ${c.summary}`)
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
      messages: [{ role: "user", content: text }],
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
