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

export async function summarizeTaskOpenAI(
  text: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<string> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(cfg, {
      model,
      temperature: cfg.temperature ?? 0.1,
      max_tokens: 4096,
      messages: [
        { role: "system", content: TASK_SUMMARY_PROMPT },
        { role: "user", content: text },
      ],
    })),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI task-summarize failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message?.content?.trim() ?? "";
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

export async function generateTaskTitleOpenAI(
  text: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<string> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(cfg, {
      model,
      temperature: 0,
      max_tokens: 100,
      messages: [
        { role: "system", content: TASK_TITLE_PROMPT },
        { role: "user", content: text },
      ],
    })),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI task-title failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message?.content?.trim() ?? "";
}

export async function summarizeOpenAI(
  text: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<string> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(cfg, {
      model,
      temperature: cfg.temperature ?? 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `[TEXT TO SUMMARIZE]\n${text}\n[/TEXT TO SUMMARIZE]` },
      ],
    })),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI summarize failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return json.choices[0]?.message?.content?.trim() ?? "";
}

const TOPIC_JUDGE_PROMPT = `You are a conversation topic boundary detector. Given the CURRENT task context and a NEW user message, decide if the new message belongs to the SAME task or starts a NEW one.

Answer ONLY "NEW" or "SAME".

SAME — the new message:
- Continues, follows up on, refines, or corrects the same subject/project/task
- Asks a clarification or next-step question about what was just discussed
- Reports a result, error, or feedback about the current task
- Discusses different tools or approaches for the SAME goal (e.g., learning English via BBC → via ChatGPT = SAME)
- Is a short acknowledgment (ok, thanks, 好的) in response to the current flow
- Is a follow-up, update, or different angle on the same news event, person, or story
- Shares the same core entity (person, company, event) even if the specific detail or angle differs
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
- If the new message mentions the same person, event, product, or entity as the current task, it is SAME regardless of the angle
- Different aspects of the SAME project/system are SAME (e.g., Nginx SSL → Nginx gzip = SAME)
- Asking about tools, systems, or methods for the current topic is SAME (e.g., "港股调研" → "那处理系统有哪些" = SAME; "数据分析" → "用什么工具" = SAME)
- Follow-up news about the same event is SAME (e.g., "博士失联" → "博士遗体被找到" = SAME; "产品发布" → "产品销量" = SAME)
- Different unrelated domains discussed independently are NEW (e.g., Redis config → cooking recipe = NEW)
- Examples: "配置Nginx" → "加gzip压缩" = SAME; "配置Nginx" → "做红烧肉" = NEW; "港股调研" → "那处理系统有哪些" = SAME; "部署服务器" → "年会安排" = NEW

Output exactly one word: NEW or SAME`;

export async function judgeNewTopicOpenAI(
  currentContext: string,
  newMessage: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<boolean> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const userContent = `CURRENT TASK CONTEXT:\n${currentContext}\n\n---\n\nNEW USER MESSAGE:\n${newMessage}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(cfg, {
      model,
      temperature: 0,
      max_tokens: 10,
      messages: [
        { role: "system", content: TOPIC_JUDGE_PROMPT },
        { role: "user", content: userContent },
      ],
    })),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI topic-judge failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  const answer = json.choices[0]?.message?.content?.trim().toUpperCase() ?? "";
  log.debug(`Topic judge result: "${answer}"`);
  return answer.startsWith("NEW");
}

// ─── Structured Topic Classifier ───

export interface TopicClassifyResult {
  decision: "NEW" | "SAME";
  confidence: number;
  boundaryType: string;
  reason: string; // may be empty for compact responses
}

const TOPIC_CLASSIFIER_PROMPT = `Classify if NEW MESSAGE continues current task or starts an unrelated one.
Output ONLY JSON: {"d":"S"|"N","c":0.0-1.0}
d=S(same) or N(new). c=confidence. Default S. Only N if completely unrelated domain.
Sub-questions, tools, methods, details of current topic = S.`;

export async function classifyTopicOpenAI(
  taskState: string,
  newMessage: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<TopicClassifyResult> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const userContent = `TASK:\n${taskState}\n\nMSG:\n${newMessage}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(cfg, {
      model,
      temperature: 0,
      max_tokens: 60,
      messages: [
        { role: "system", content: TOPIC_CLASSIFIER_PROMPT },
        { role: "user", content: userContent },
      ],
    })),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI topic-classifier failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  const raw = json.choices[0]?.message?.content?.trim() ?? "";
  log.debug(`Topic classifier raw: "${raw}"`);

  return parseTopicClassifyResult(raw, log);
}

const TOPIC_ARBITRATION_PROMPT = `A classifier flagged this message as possibly new topic (low confidence). Is it truly UNRELATED, or a sub-question/follow-up?
Tools/methods/details of current task = SAME. Shared entity/theme = SAME. Entirely different domain = NEW.
Reply one word: NEW or SAME`;

export async function arbitrateTopicSplitOpenAI(
  taskState: string,
  newMessage: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<string> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const userContent = `TASK:\n${taskState}\n\nMSG:\n${newMessage}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(cfg, {
      model,
      temperature: 0,
      max_tokens: 10,
      messages: [
        { role: "system", content: TOPIC_ARBITRATION_PROMPT },
        { role: "user", content: userContent },
      ],
    })),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI topic-arbitration failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  const answer = json.choices[0]?.message?.content?.trim().toUpperCase() ?? "";
  log.debug(`Topic arbitration result: "${answer}"`);
  return answer.startsWith("NEW") ? "NEW" : "SAME";
}

export function parseTopicClassifyResult(raw: string, log: Logger): TopicClassifyResult {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const p = JSON.parse(jsonMatch[0]);
      const decision: "NEW" | "SAME" =
        (p.d === "N" || p.decision === "NEW") ? "NEW" : "SAME";
      const confidence: number =
        typeof p.c === "number" ? p.c : typeof p.confidence === "number" ? p.confidence : 0.5;
      return {
        decision,
        confidence,
        boundaryType: p.boundaryType || "",
        reason: p.reason || "",
      };
    }
  } catch (err) {
    log.debug(`Failed to parse topic classify JSON: ${err}`);
  }
  const upper = raw.toUpperCase();
  if (upper.startsWith("NEW") || upper.startsWith("N"))
    return { decision: "NEW", confidence: 0.5, boundaryType: "", reason: "parse fallback" };
  return { decision: "SAME", confidence: 0.5, boundaryType: "", reason: "parse fallback" };
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
4. DEDUPLICATION: When multiple candidates convey the same or very similar information, keep ONLY the most complete/detailed one and exclude the rest. Do NOT return near-duplicate snippets.

OUTPUT — JSON only:
{"relevant":[1,3],"sufficient":true}
- "relevant": candidate numbers whose content helps answer the query. [] if none can help. Duplicates removed — only unique information.
- "sufficient": true only if the selected memories fully answer the query.`;

export interface FilterResult {
  relevant: number[];
  sufficient: boolean;
}

export async function filterRelevantOpenAI(
  query: string,
  candidates: Array<{ index: number; role: string; content: string; time?: string }>,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<FilterResult> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
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
    body: JSON.stringify(buildRequestBody(cfg, {
      model,
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: "system", content: FILTER_RELEVANT_PROMPT },
        { role: "user", content: `QUERY: ${query}\n\nCANDIDATES:\n${candidateText}` },
      ],
    })),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI filter-relevant failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  const raw = json.choices[0]?.message?.content?.trim() ?? "{}";
  log.debug(`filterRelevant raw LLM response: "${raw}"`);
  return parseFilterResult(raw, log);
}

export function parseFilterResult(raw: string, log: Logger): FilterResult {
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

// ─── Smart Dedup: judge whether new memory is DUPLICATE / UPDATE / NEW ───

export const DEDUP_JUDGE_PROMPT = `You are a memory deduplication system.

LANGUAGE RULE (MUST FOLLOW): You MUST reply in the SAME language as the input memories. 如果输入是中文，reason 和 mergedSummary 必须用中文。If input is English, reply in English. This applies to ALL text fields in your JSON output.

Given a NEW memory summary and several EXISTING memory summaries, determine the relationship.

For each EXISTING memory, the NEW memory is either:
- "DUPLICATE": NEW conveys the same intent/meaning as an EXISTING memory, even if worded differently. Examples: "请告诉我你的名字" vs "你希望我怎么称呼你"; "新会话已开始" vs "New session started"; greetings with minor variations. If the core information/intent is the same, it IS a duplicate.
- "UPDATE": NEW contains meaningful additional information that supplements an EXISTING memory (new data, status change, concrete detail not present before)
- "NEW": NEW covers a genuinely different topic/event with no semantic overlap

IMPORTANT: Lean toward DUPLICATE when memories share the same intent, topic, or factual content. Only choose NEW when the topics are truly unrelated. Repetitive conversational patterns (greetings, session starts, identity questions, capability descriptions) across different sessions should be treated as DUPLICATE.

Pick the BEST match among all candidates. If none match well, choose "NEW".

Output a single JSON object (reason and mergedSummary MUST match input language):
- If DUPLICATE: {"action":"DUPLICATE","targetIndex":2,"reason":"与已有记忆意图相同"}
- If UPDATE: {"action":"UPDATE","targetIndex":3,"reason":"新记忆补充了额外细节","mergedSummary":"合并后的完整摘要，保留新旧所有信息"}
- If NEW: {"action":"NEW","reason":"不同主题，无关联"}

Output ONLY the JSON object, no other text.`;

export interface DedupResult {
  action: "DUPLICATE" | "UPDATE" | "NEW";
  targetIndex?: number;
  reason: string;
  mergedSummary?: string;
}

export async function judgeDedupOpenAI(
  newSummary: string,
  candidates: Array<{ index: number; summary: string; chunkId: string }>,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<DedupResult> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const candidateText = candidates
    .map((c) => `${c.index}. ${c.summary}`)
    .join("\n");

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(cfg, {
      model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: DEDUP_JUDGE_PROMPT },
        { role: "user", content: `NEW MEMORY:\n${newSummary}\n\nEXISTING MEMORIES:\n${candidateText}` },
      ],
    })),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI dedup-judge failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  const raw = json.choices[0]?.message?.content?.trim() ?? "{}";
  return parseDedupResult(raw, log);
}

export function parseDedupResult(raw: string, log: Logger): DedupResult {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]);
      if (obj && typeof obj.action === "string") {
        return {
          action: obj.action as DedupResult["action"],
          targetIndex: typeof obj.targetIndex === "number" ? obj.targetIndex : undefined,
          reason: obj.reason || "",
          mergedSummary: obj.mergedSummary || undefined,
        };
      }
    }
  } catch {}
  log.warn(`judgeDedup: failed to parse LLM output: "${raw}", fallback to NEW`);
  return { action: "NEW", reason: "parse_failed" };
}

function normalizeChatEndpoint(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (stripped.endsWith("/chat/completions")) return stripped;
  if (stripped.endsWith("/completions")) return stripped;
  return `${stripped}/chat/completions`;
}

/**
 * Zhipu AI (glm-4.7, glm-5, etc.) uses reasoning tokens that consume max_tokens budget,
 * leaving no room for actual output. This helper injects {"thinking":{"type":"disabled"}}
 * for zhipu endpoints to disable the built-in reasoning mode.
 */
function isZhipuEndpoint(endpoint: string): boolean {
  return /bigmodel\.cn|zhipuai/.test(endpoint);
}

function buildRequestBody(cfg: SummarizerConfig, body: Record<string, unknown>): Record<string, unknown> {
  const endpoint = cfg.endpoint ?? "";
  if (isZhipuEndpoint(endpoint)) {
    body.thinking = { type: "disabled" };
  }
  return body;
}
