/**
 * Intent Filter Module
 * Determines if a user query requires memory retrieval.
 * 
 * Design Principle: Rather skip than pollute context with irrelevant hits.
 */

import {
  compilePatterns,
  matchPatterns,
  MEMORY_QUERY_PATTERN_SOURCES,
  SKIP_RECALL_PATTERN_SOURCES,
} from "./intent-patterns";

const DEFAULT_AUTO_RECALL_MAX_RESULTS = 10;

export type IntentFilterOptions = {
  /** LLM intent judgment timeout (ms) */
  llmTimeoutMs?: number;
  /** Fallback strategy on LLM error/timeout */
  onLlmError?: "skip" | "search";
  /** Minimum confidence level to trigger search */
  minConfidenceForSearch?: "high" | "medium";
  /** Maximum LLM output length, exceeds treated as abnormal */
  maxLlmOutputLength?: number;
  /** Max results for auto-recall (provided as a config interface for callers) */
  autoRecallMaxResults?: number;
};

export const DEFAULT_INTENT_FILTER_OPTIONS: Required<
  Pick<IntentFilterOptions, "llmTimeoutMs" | "onLlmError" | "minConfidenceForSearch" | "maxLlmOutputLength">
> = {
  llmTimeoutMs: 2000,
  onLlmError: "skip",
  minConfidenceForSearch: "high",
  maxLlmOutputLength: 400,
};

// ====== Pattern Matching Rules ======

/** Conversation continuation: No memory/search needed, let LLM reply based on current context */
const compiledSkipRecallPatterns = compilePatterns(SKIP_RECALL_PATTERN_SOURCES);

/** Explicit memory retrieval: High confidence memory queries */
const compiledMemoryQueryPatterns = compilePatterns(MEMORY_QUERY_PATTERN_SOURCES);

// ====== LLM Prompt ======

const intentPromptTemplate = (query: string) => `You are a query intent analyzer. Determine if the following user query requires "Memory Retrieval".

Judgment Criteria (Strictly Follow):
- "Memory Retrieval (High)": User explicitly refers to specific past conversation details (e.g., "the bug fix we discussed last time", "the pricing strategy mentioned yesterday"). Must contain a specific subject.
- "Memory Retrieval (Medium)": User refers to the past but vaguely (e.g., "last news", "previous issues"). Clear temporal pointer but blurry content.
- "Real-time Search": User wants current data (weather, news, stock prices) or just general search (e.g., "search for news").
- "Skip": Vague or ambiguous queries (e.g., "optimise this", "what should I do", "continue", single-word replies).

User Query: "${query}"

Output Format (Strictly Follow):
Intent: <Memory Retrieval|Real-time Search|Skip>
Confidence: <High|Medium|Low>
Reason: <Brief one-sentence explanation in English>`;

// ====== Type Definitions ======

export type IntentResult = {
  action: 'skip' | 'search' | 'llm_judge';
  reason: string;
  /** LLM prompt (only if action='llm_judge') */
  llmPrompt?: string;
};

export type LLMJudgeResult = {
  action: 'skip' | 'search';
  reason: string;
  /** Raw LLM output (for debugging) */
  raw?: string;
};

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[：﹕︰]/g, ":")
    .trim();
}

function pickFieldFromObject(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function parseJsonLikeIntent(output: string): { intent: string; confidence: string } | null {
  // Try full string first
  try {
    const full = JSON.parse(output) as Record<string, unknown>;
    return {
      intent: pickFieldFromObject(full, ["intent", "意图", "label", "category"]),
      confidence: pickFieldFromObject(full, ["confidence", "置信度", "conf"]),
    };
  } catch {
    // Fallback to JSON snippets (non-greedy) for mixed text output.
  }

  for (const m of output.matchAll(/\{[\s\S]*?\}/g)) {
    try {
      const parsed = JSON.parse(m[0]) as Record<string, unknown>;
      const intent = pickFieldFromObject(parsed, ["intent", "意图", "label", "category"]);
      const confidence = pickFieldFromObject(parsed, ["confidence", "置信度", "conf"]);
      if (intent || confidence) return { intent, confidence };
    } catch {
      // continue
    }
  }
  return null;
}

function extractIntentAndConfidence(output: string): { intent: string; confidence: string } {
  const jsonParsed = parseJsonLikeIntent(output);
  if (jsonParsed) return jsonParsed;

  const intentLine = output.match(/^(?:意图|intent)\s*:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const confidenceLine = output.match(/^(?:置信度|confidence)\s*:\s*(.+)$/im)?.[1]?.trim() ?? "";
  return { intent: intentLine, confidence: confidenceLine };
}

function isMemoryIntent(intent: string): boolean {
  const v = intent.toLowerCase();
  return (
    intent.includes("记忆检索") ||
    intent.includes("回忆") ||
    /memory\s*(retrieval|search|recall)/i.test(v) ||
    /search\s*memory/i.test(v)
  );
}

function confidenceRank(confidence: string): number {
  const v = confidence.toLowerCase();
  if (confidence.includes("高") || /high/.test(v)) return 3;
  if (confidence.includes("中") || /medium|med/.test(v)) return 2;
  if (confidence.includes("低") || /low/.test(v)) return 1;
  return 0;
}

function requiredConfidenceRank(level: "high" | "medium"): number {
  return level === "high" ? 3 : 2;
}

// ====== Main Functions ======

/**
 * Determines if query should be skipped, searched directly, or judged by LLM
 * @param query User query
 * @returns Result
 */
export function shouldSkipOrSearch(query: string): IntentResult {
  const normalizedQuery = query.trim();

  // 1. Continuation command -> Skip
  if (matchPatterns(normalizedQuery, compiledSkipRecallPatterns)) {
    return { action: 'skip', reason: 'skip_continue_command' };
  }

  // 2. Explicit memory query -> Search (skip LLM)
  if (matchPatterns(normalizedQuery, compiledMemoryQueryPatterns)) {
    return { action: 'search', reason: 'explicit_memory_query' };
  }

  // 3. Others -> LLM judge
  return {
    action: 'llm_judge',
    reason: 'needs_llm_judgment',
    llmPrompt: intentPromptTemplate(normalizedQuery),
  };
}

/**
 * Parses LLM intent judgment output
 * @param llmOutput Raw LLM output
 * @param query User query (for logging)
 * @returns Judgment result
 */
export function parseLLMIntent(llmOutput: string, query: string, options?: IntentFilterOptions): LLMJudgeResult {
  const output = normalizeText(llmOutput ?? '');
  const maxOutputLength = options?.maxLlmOutputLength ?? DEFAULT_INTENT_FILTER_OPTIONS.maxLlmOutputLength;

  // Error tolerance: LLM failed (returns prompt or too long)
  const llmFailed =
    output.includes('You are a query intent analyzer') ||
    output.toLowerCase().includes('you are a query intent analyzer') ||
    output.length > maxOutputLength;
  if (llmFailed) {
    const fallbackAction = options?.onLlmError ?? 'skip';
    return { action: fallbackAction, reason: 'llm_failed_skipped', raw: output };
  }

  // Parse fields
  const { intent, confidence } = extractIntentAndConfidence(output);
  const threshold = options?.minConfidenceForSearch ?? DEFAULT_INTENT_FILTER_OPTIONS.minConfidenceForSearch;
  const shouldSearchMemory =
    isMemoryIntent(intent) &&
    confidenceRank(confidence) >= requiredConfidenceRank(threshold);

  if (shouldSearchMemory) {
    return { action: 'search', reason: `intent=${intent},confidence=${confidence}`, raw: output };
  }

  const reason = intent || confidence
    ? `intent=${intent},confidence=${confidence}`
    : `intent=unknown,confidence=unknown,query=${query.slice(0, 40)}`;
  return { action: 'skip', reason, raw: output };
}

/**
 * Executes intent judgment logic (used in index.ts)
 */
export async function executeIntentJudge(params: {
  query: string;
  summarizer: { summarize: (prompt: string) => Promise<string | null> };
  ctx: { log: { debug: (m: string) => void; info: (m: string) => void; warn: (m: string) => void } };
  store: {
    recordToolCall: (name: string, duration: number, success: boolean) => void;
    recordApiLog: (name: string, payload: any, result: string, duration: number, success: boolean) => void;
  };
  recallT0: number;
  performance: { now: () => number };
  options?: IntentFilterOptions;
}): Promise<{ shouldSearch: boolean }> {
  const { query, summarizer, ctx, store, recallT0, performance, options } = params;
  const policy = {
    ...DEFAULT_INTENT_FILTER_OPTIONS,
    ...(options ?? {}),
  };
  const timerApi = globalThis as any;

  const intentCheck = shouldSkipOrSearch(query);

  // 1. Direct Skip
  if (intentCheck.action === 'skip') {
    ctx.log.debug(`auto-recall: skipped query "${query}" reason=${intentCheck.reason}`);
    const dur = performance.now() - recallT0;
    store.recordApiLog("auto_recall_intent_skip", { type: "auto_recall", query, reason: intentCheck.reason }, "skipped", dur, true);
    return { shouldSearch: false };
  }

  // 2. Explicit memory query -> Search
  if (intentCheck.action === 'search') {
    ctx.log.debug(`auto-recall: explicit memory query "${query}"`);
    return { shouldSearch: true };
  }

  // 3. Others -> LLM Judge
  try {
    const timeoutError = new Error("intent_judge_timeout");
    let tid: any;
    const timeoutPromise = new Promise<null>((_, reject) => {
      tid = timerApi.setTimeout(() => reject(timeoutError), policy.llmTimeoutMs);
    });

    const intentResult = await Promise.race([
      summarizer.summarize(intentCheck.llmPrompt!),
      timeoutPromise,
    ]).finally(() => {
      if (tid !== undefined) timerApi.clearTimeout(tid);
    });

    ctx.log.debug(`auto-recall: LLM intent result="${intentResult}"`);

    const parsed = parseLLMIntent(intentResult ?? '', query, policy);

    if (parsed.action === 'skip') {
      if (parsed.reason === 'llm_failed_skipped') {
        ctx.log.warn(`auto-recall: LLM call failed, skipping memory retrieval by default (fallback policy)`);
      } else {
        ctx.log.info(`auto-recall: skipped query "${query.slice(0, 50)}" reason=${parsed.reason}`);
      }
      const dur = performance.now() - recallT0;
      store.recordApiLog("auto_recall_intent_skip", { type: "auto_recall", query, reason: parsed.reason }, "skipped", dur, true);
      return { shouldSearch: false };
    }

    return { shouldSearch: true };
  } catch (intentErr) {
    if (policy.onLlmError === "search") {
      ctx.log.warn(`auto-recall: LLM intent judgment failed, proceeding with retrieval (config policy): ${intentErr}`);
      return { shouldSearch: true };
    }
    ctx.log.warn(`auto-recall: LLM intent judgment failed: ${intentErr}`);
    const dur = performance.now() - recallT0;
    store.recordApiLog("auto_recall_intent_skip", { type: "auto_recall", query, reason: "llm_error_skipped" }, "skipped", dur, true);
    return { shouldSearch: false };
  }
}

/**
 * Resolves auto-recall max results configuration
 */
export function resolveAutoRecallMaxResults(options?: IntentFilterOptions): number {
  const raw = options?.autoRecallMaxResults;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_AUTO_RECALL_MAX_RESULTS;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > 20) return 20;
  return n;
}
