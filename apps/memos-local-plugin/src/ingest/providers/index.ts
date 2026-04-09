import * as fs from "fs";
import * as path from "path";
import type { SummarizerConfig, SummaryProvider, Logger, OpenClawAPI } from "../../types";
import { summarizeOpenAI, summarizeTaskOpenAI, generateTaskTitleOpenAI, judgeNewTopicOpenAI, classifyTopicOpenAI, arbitrateTopicSplitOpenAI, filterRelevantOpenAI, judgeDedupOpenAI, parseFilterResult, parseDedupResult, parseTopicClassifyResult } from "./openai";
import type { FilterResult, DedupResult, TopicClassifyResult } from "./openai";
export type { FilterResult, DedupResult, TopicClassifyResult } from "./openai";
import { summarizeAnthropic, summarizeTaskAnthropic, generateTaskTitleAnthropic, judgeNewTopicAnthropic, filterRelevantAnthropic, judgeDedupAnthropic } from "./anthropic";
import { summarizeGemini, summarizeTaskGemini, generateTaskTitleGemini, judgeNewTopicGemini, filterRelevantGemini, judgeDedupGemini } from "./gemini";
import { summarizeBedrock, summarizeTaskBedrock, generateTaskTitleBedrock, judgeNewTopicBedrock, filterRelevantBedrock, judgeDedupBedrock } from "./bedrock";

/**
 * Resolve a SecretInput (string | SecretRef) to a plain string.
 * Supports env-sourced SecretRef from OpenClaw's credential system.
 */
function resolveApiKey(
  input: string | { source: string; provider?: string; id: string } | undefined,
): string | undefined {
  if (!input) return undefined;
  if (typeof input === "string") return input;
  if (input.source === "env") return process.env[input.id];
  return undefined;
}

/**
 * Detect provider type from provider key name or base URL.
 */
function detectProvider(
  providerKey: string | undefined,
  baseUrl: string,
): SummaryProvider {
  const key = providerKey?.toLowerCase() ?? "";
  const url = baseUrl.toLowerCase();
  if (key.includes("anthropic") || url.includes("anthropic")) return "anthropic";
  if (key.includes("gemini") || url.includes("generativelanguage.googleapis.com")) {
    return "gemini";
  }
  if (key.includes("bedrock") || url.includes("bedrock")) return "bedrock";
  return "openai_compatible";
}

/**
 * Return the correct endpoint for a given provider and base URL.
 */
function normalizeEndpointForProvider(
  provider: SummaryProvider,
  baseUrl: string,
): string {
  const stripped = baseUrl.replace(/\/+$/, "");
  if (provider === "anthropic") {
    if (stripped.endsWith("/v1/messages")) return stripped;
    return `${stripped}/v1/messages`;
  }
  if (stripped.endsWith("/chat/completions")) return stripped;
  if (stripped.endsWith("/completions")) return stripped;
  return `${stripped}/chat/completions`;
}

/**
 * Build a SummarizerConfig from OpenClaw's native model configuration (openclaw.json).
 * This serves as the final fallback when both strongCfg and plugin summarizer fail or are absent.
 */
function loadOpenClawFallbackConfig(log: Logger): SummarizerConfig | undefined {
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const cfgPath = process.env.OPENCLAW_CONFIG_PATH
      || path.join(process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw"), "openclaw.json");
    if (!fs.existsSync(cfgPath)) return undefined;

    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));

    const agentModel: string | undefined = raw?.agents?.defaults?.model?.primary;
    if (!agentModel) return undefined;

    const [providerKey, modelId] = agentModel.includes("/")
      ? agentModel.split("/", 2)
      : [undefined, agentModel];

    const providerCfg = providerKey
      ? raw?.models?.providers?.[providerKey]
      : Object.values(raw?.models?.providers ?? {})[0] as any;
    if (!providerCfg) return undefined;

    const baseUrl: string | undefined = providerCfg.baseUrl;
    const apiKey = resolveApiKey(providerCfg.apiKey);
    if (!baseUrl || !apiKey) return undefined;

    const provider = detectProvider(providerKey, baseUrl);
    const endpoint = normalizeEndpointForProvider(provider, baseUrl);

    log.debug(`OpenClaw fallback model: ${modelId} via ${baseUrl} (${provider})`);
    return {
      provider,
      endpoint,
      apiKey,
      model: modelId,
    };
  } catch (err) {
    log.debug(`Failed to load OpenClaw fallback config: ${err}`);
    return undefined;
  }
}

// ─── Model Health Tracking ───

export interface ModelHealthEntry {
  role: string;
  status: "ok" | "degraded" | "error" | "unknown";
  lastSuccess: number | null;
  lastError: number | null;
  lastErrorMessage: string | null;
  consecutiveErrors: number;
  model: string | null;
  failedModel: string | null;
}

class ModelHealthTracker {
  private state = new Map<string, ModelHealthEntry>();
  private pendingErrors = new Map<string, { model: string; error: string }>();

  recordSuccess(role: string, model: string): void {
    const entry = this.getOrCreate(role);
    const pending = this.pendingErrors.get(role);
    if (pending) {
      entry.status = "degraded";
      entry.lastError = Date.now();
      entry.lastErrorMessage = pending.error.length > 300 ? pending.error.slice(0, 300) + "..." : pending.error;
      entry.failedModel = pending.model;
      this.pendingErrors.delete(role);
    } else {
      entry.status = "ok";
    }
    entry.lastSuccess = Date.now();
    entry.consecutiveErrors = 0;
    entry.model = model;
  }

  recordError(role: string, model: string, error: string): void {
    const entry = this.getOrCreate(role);
    entry.lastError = Date.now();
    entry.lastErrorMessage = error.length > 300 ? error.slice(0, 300) + "..." : error;
    entry.consecutiveErrors++;
    entry.failedModel = model;
    entry.status = "error";
    this.pendingErrors.set(role, { model, error: entry.lastErrorMessage });
  }

  getAll(): ModelHealthEntry[] {
    return [...this.state.values()];
  }

  private getOrCreate(role: string): ModelHealthEntry {
    let entry = this.state.get(role);
    if (!entry) {
      entry = { role, status: "unknown", lastSuccess: null, lastError: null, lastErrorMessage: null, consecutiveErrors: 0, model: null, failedModel: null };
      this.state.set(role, entry);
    }
    return entry;
  }
}

export const modelHealth = new ModelHealthTracker();

export class Summarizer {
  private strongCfg: SummarizerConfig | undefined;
  private fallbackCfg: SummarizerConfig | undefined;

  constructor(
    private cfg: SummarizerConfig | undefined,
    private log: Logger,
    private openclawAPI?: OpenClawAPI,
    strongCfg?: SummarizerConfig,
  ) {
    this.strongCfg = strongCfg;
    this.fallbackCfg = loadOpenClawFallbackConfig(log);
  }

  /**
   * Ordered config chain: strongCfg → cfg → fallbackCfg (OpenClaw native model).
   * Returns configs that are defined, in priority order.
   * Openclaw configs without hostCompletion capability or without openclawAPI are excluded.
   */
  private getConfigChain(): SummarizerConfig[] {
    const chain: SummarizerConfig[] = [];
    if (this.strongCfg) chain.push(this.strongCfg);
    if (this.cfg) {
      if (this.cfg.provider === "openclaw") {
        if (this.cfg.capabilities?.hostCompletion === true && this.openclawAPI) {
          chain.push(this.cfg);
        }
      } else {
        chain.push(this.cfg);
      }
    }
    if (this.fallbackCfg) chain.push(this.fallbackCfg);
    return chain;
  }

  /**
   * Try calling fn with each config in the chain until one succeeds.
   * Returns undefined if all fail.
   */
  private async tryChain<T>(
    label: string,
    fn: (cfg: SummarizerConfig) => Promise<T>,
  ): Promise<T | undefined> {
    const chain = this.getConfigChain();
    for (let i = 0; i < chain.length; i++) {
      const modelInfo = `${chain[i].provider}/${chain[i].model ?? "?"}`;
      try {
        const result = await fn(chain[i]);
        modelHealth.recordSuccess(label, modelInfo);
        return result;
      } catch (err) {
        const level = i < chain.length - 1 ? "warn" : "error";
        this.log[level](`${label} failed (${modelInfo}), ${i < chain.length - 1 ? "trying next" : "no more fallbacks"}: ${err}`);
        modelHealth.recordError(label, modelInfo, String(err));
      }
    }
    return undefined;
  }

  async summarize(text: string): Promise<string> {
    const cleaned = stripMarkdown(text).trim();

    if (wordCount(cleaned) <= 10) {
      return cleaned;
    }

    if (!this.cfg && !this.fallbackCfg) {
      return ruleFallback(cleaned);
    }

    const accept = (s: string | undefined): s is string =>
      !!s && s.length > 0 && s.length < cleaned.length;

    let llmCalled = false;
    try {
      const result = await this.tryChain("summarize", (cfg) => callSummarize(cfg, text, this.log));
      llmCalled = true;
      const resultCleaned = result ? stripMarkdown(result).trim() : undefined;

      if (accept(resultCleaned)) {
        return resultCleaned;
      }

      if (resultCleaned !== undefined && resultCleaned !== null) {
        const len: number = (resultCleaned as string).length;
        this.log.warn(`summarize: result (${len}) >= input (${cleaned.length}), retrying`);
      }
    } catch (err) {
      this.log.warn(`summarize primary failed: ${err}`);
    }

    const fallback = this.fallbackCfg ?? this.cfg;
    if (fallback) {
      try {
        const retry = await callSummarize(fallback, text, this.log);
        llmCalled = true;
        const retryCleaned = retry ? stripMarkdown(retry).trim() : undefined;
        if (accept(retryCleaned)) {
          modelHealth.recordSuccess("summarize", `${fallback.provider}/${fallback.model ?? "?"}`);
          return retryCleaned;
        }
      } catch (err) {
        this.log.warn(`summarize fallback retry failed: ${err}`);
      }
    }

    return llmCalled ? cleaned : ruleFallback(cleaned);
  }

  async summarizeTask(text: string): Promise<string> {
    if (!this.cfg && !this.fallbackCfg) {
      return taskFallback(text);
    }

    const result = await this.tryChain("summarizeTask", (cfg) =>
      cfg.provider === "openclaw" ? this.summarizeTaskOpenClaw(text) : callSummarizeTask(cfg, text, this.log),
    );
    return result ?? taskFallback(text);
  }

  async generateTaskTitle(text: string): Promise<string> {
    if (!this.cfg && !this.fallbackCfg) return "";
    const result = await this.tryChain("generateTaskTitle", (cfg) => callGenerateTaskTitle(cfg, text, this.log));
    return result ?? "";
  }

  async judgeNewTopic(currentContext: string, newMessage: string): Promise<boolean | null> {
    const result = await this.tryChain("judgeNewTopic", (cfg) =>
      cfg.provider === "openclaw"
        ? this.judgeNewTopicOpenClaw(currentContext, newMessage)
        : callTopicJudge(cfg, currentContext, newMessage, this.log),
    );
    return result ?? null;
  }

  async classifyTopic(taskState: string, newMessage: string): Promise<TopicClassifyResult | null> {
    const result = await this.tryChain("classifyTopic", (cfg) =>
      cfg.provider === "openclaw"
        ? this.classifyTopicOpenClaw(taskState, newMessage)
        : callTopicClassifier(cfg, taskState, newMessage, this.log),
    );
    return result ?? null;
  }

  async arbitrateTopicSplit(taskState: string, newMessage: string): Promise<string | null> {
    const result = await this.tryChain("arbitrateTopicSplit", (cfg) =>
      cfg.provider === "openclaw"
        ? this.arbitrateTopicSplitOpenClaw(taskState, newMessage)
        : callTopicArbitration(cfg, taskState, newMessage, this.log),
    );
    return result ?? null;
  }

  async filterRelevant(
    query: string,
    candidates: Array<{ index: number; role: string; content: string; time?: string }>,
  ): Promise<FilterResult | null> {
    if (!this.cfg && !this.fallbackCfg) return null;
    if (candidates.length === 0) return { relevant: [], sufficient: true };

    const result = await this.tryChain("filterRelevant", (cfg) =>
      cfg.provider === "openclaw"
        ? this.filterRelevantOpenClaw(query, candidates)
        : callFilterRelevant(cfg, query, candidates, this.log),
    );
    return result ?? null;
  }

  async judgeDedup(
    newSummary: string,
    candidates: Array<{ index: number; summary: string; chunkId: string }>,
  ): Promise<DedupResult | null> {
    if (!this.cfg && !this.fallbackCfg) return null;
    if (candidates.length === 0) return null;

    const result = await this.tryChain("judgeDedup", (cfg) =>
      cfg.provider === "openclaw"
        ? this.judgeDedupOpenClaw(newSummary, candidates)
        : callJudgeDedup(cfg, newSummary, candidates, this.log),
    );
    return result ?? { action: "NEW", reason: "all_models_failed" };
  }

  getStrongConfig(): SummarizerConfig | undefined {
    return this.strongCfg;
  }

  // ─── OpenClaw Prompts ───

  static readonly OPENCLAW_TOPIC_JUDGE_PROMPT = `You are a conversation topic change detector.
Given a CURRENT CONVERSATION SUMMARY and a NEW USER MESSAGE, decide: has the user started a COMPLETELY NEW topic that is unrelated to the current conversation?
Default to SAME unless the domain clearly changed. If the new message shares the same person, event, entity, or theme with the current conversation, answer SAME.
CRITICAL: Short messages (under ~30 characters) that use pronouns (那/这/它/哪些) or ask about tools/details/dimensions of the current topic are almost always follow-ups — answer SAME unless they explicitly name a completely unrelated domain.
Reply with a single word: "NEW" if topic changed, "SAME" if it continues.`;

  static readonly OPENCLAW_TOPIC_CLASSIFIER_PROMPT = `Classify if NEW MESSAGE continues current task or starts an unrelated one.
Output ONLY JSON: {"d":"S"|"N","c":0.0-1.0}
d=S(same) or N(new). c=confidence. Default S. Only N if completely unrelated domain.
Sub-questions, tools, methods, details of current topic = S.`;

  static readonly OPENCLAW_TOPIC_ARBITRATION_PROMPT = `A classifier flagged this message as possibly new topic (low confidence). Is it truly UNRELATED, or a sub-question/follow-up?
Tools/methods/details of current task = SAME. Shared entity/theme = SAME. Entirely different domain = NEW.
Reply one word: NEW or SAME`;

  static readonly OPENCLAW_FILTER_RELEVANT_PROMPT = `You are a memory relevance judge.
Given a QUERY and CANDIDATE memories, decide: does each candidate help answer the query?
RULES:
1. Include candidates whose content provides useful facts/context for the query.
2. Exclude candidates that merely share a topic but contain no useful information.
3. DEDUPLICATION: When multiple candidates convey the same or very similar information, keep ONLY the most complete one and exclude the rest.
4. If none help, return {"relevant":[],"sufficient":false}.
OUTPUT — JSON only: {"relevant":[1,3],"sufficient":true}`;

  static readonly OPENCLAW_DEDUP_JUDGE_PROMPT = `You are a memory deduplication system.
Given a NEW memory summary and EXISTING candidates, decide if the new memory duplicates any existing one.
Reply with JSON: {"action":"MERGE","mergeTarget":2,"reason":"..."} or {"action":"NEW","reason":"..."}`;

  static readonly OPENCLAW_TASK_SUMMARY_PROMPT = `Summarize the following task conversation into a structured report. Preserve key decisions, code, commands, and outcomes. Use the same language as the input.`;

  // ─── OpenClaw API Implementation ───

  private requireOpenClawAPI(): void {
    if (!this.openclawAPI) {
      throw new Error(
        "OpenClaw API not available. Ensure sharing.capabilities.hostCompletion is enabled in config."
      );
    }
  }

  private async summarizeOpenClaw(text: string): Promise<string> {
    this.requireOpenClawAPI();
    const prompt = [
      `Summarize the text in ONE concise sentence (max 120 characters). IMPORTANT: Use the SAME language as the input text — if the input is Chinese, write Chinese; if English, write English. Preserve exact names, commands, error codes. No bullet points, no preamble — output only the sentence.`,
      ``,
      text.slice(0, 2000),
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 100,
      temperature: 0,
      model: this.cfg?.model,
    });

    return response.text.trim().slice(0, 200);
  }

  private async summarizeTaskOpenClaw(text: string): Promise<string> {
    this.requireOpenClawAPI();
    const prompt = [
      Summarizer.OPENCLAW_TASK_SUMMARY_PROMPT,
      ``,
      text,
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 4096,
      temperature: 0.1,
      model: this.cfg?.model,
    });

    return response.text.trim();
  }

  private async judgeNewTopicOpenClaw(currentContext: string, newMessage: string): Promise<boolean> {
    this.requireOpenClawAPI();
    const prompt = [
      Summarizer.OPENCLAW_TOPIC_JUDGE_PROMPT,
      ``,
      `CURRENT CONVERSATION SUMMARY:`,
      currentContext,
      ``,
      `NEW USER MESSAGE:`,
      newMessage,
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 10,
      temperature: 0,
      model: this.cfg?.model,
    });

    const answer = response.text.trim().toUpperCase();
    this.log.debug(`Topic judge result: "${answer}"`);
    return answer.startsWith("NEW");
  }

  private async classifyTopicOpenClaw(taskState: string, newMessage: string): Promise<TopicClassifyResult> {
    this.requireOpenClawAPI();
    const prompt = [
      Summarizer.OPENCLAW_TOPIC_CLASSIFIER_PROMPT,
      ``,
      `TASK:\n${taskState}`,
      `\nMSG:\n${newMessage}`,
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 60,
      temperature: 0,
      model: this.cfg?.model,
    });

    return parseTopicClassifyResult(response.text.trim(), this.log);
  }

  private async arbitrateTopicSplitOpenClaw(taskState: string, newMessage: string): Promise<string> {
    this.requireOpenClawAPI();
    const prompt = [
      Summarizer.OPENCLAW_TOPIC_ARBITRATION_PROMPT,
      ``,
      `TASK:\n${taskState}`,
      `\nMSG:\n${newMessage}`,
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 10,
      temperature: 0,
      model: this.cfg?.model,
    });

    const answer = response.text.trim().toUpperCase();
    return answer.startsWith("NEW") ? "NEW" : "SAME";
  }

  private async filterRelevantOpenClaw(
    query: string,
    candidates: Array<{ index: number; role: string; content: string; time?: string }>,
  ): Promise<FilterResult> {
    this.requireOpenClawAPI();
    const candidateText = candidates
      .map((c) => `${c.index}. [${c.role}] ${c.content}`)
      .join("\n");

    const prompt = [
      Summarizer.OPENCLAW_FILTER_RELEVANT_PROMPT,
      ``,
      `QUERY: ${query}`,
      ``,
      `CANDIDATES:`,
      candidateText,
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 200,
      temperature: 0,
      model: this.cfg?.model,
    });

    return parseFilterResult(response.text.trim(), this.log);
  }

  private async judgeDedupOpenClaw(
    newSummary: string,
    candidates: Array<{ index: number; summary: string; chunkId: string }>,
  ): Promise<DedupResult> {
    this.requireOpenClawAPI();
    const candidateText = candidates
      .map((c) => `${c.index}. ${c.summary}`)
      .join("\n");

    const prompt = [
      Summarizer.OPENCLAW_DEDUP_JUDGE_PROMPT,
      ``,
      `NEW MEMORY:`,
      newSummary,
      ``,
      `EXISTING MEMORIES:`,
      candidateText,
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 300,
      temperature: 0,
      model: this.cfg?.model,
    });

    return parseDedupResult(response.text.trim(), this.log);
  }
}

// ─── Dispatch helpers ───

function callSummarize(cfg: SummarizerConfig, text: string, log: Logger): Promise<string> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
    case "zhipu":
    case "siliconflow":
    case "deepseek":
    case "moonshot":
    case "bailian":
    case "cohere":
    case "mistral":
    case "voyage":
      return summarizeOpenAI(text, cfg, log);
    case "anthropic":
      return summarizeAnthropic(text, cfg, log);
    case "gemini":
      return summarizeGemini(text, cfg, log);
    case "bedrock":
      return summarizeBedrock(text, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

function callSummarizeTask(cfg: SummarizerConfig, text: string, log: Logger): Promise<string> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
    case "zhipu":
    case "siliconflow":
    case "deepseek":
    case "moonshot":
    case "bailian":
    case "cohere":
    case "mistral":
    case "voyage":
      return summarizeTaskOpenAI(text, cfg, log);
    case "anthropic":
      return summarizeTaskAnthropic(text, cfg, log);
    case "gemini":
      return summarizeTaskGemini(text, cfg, log);
    case "bedrock":
      return summarizeTaskBedrock(text, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

function callGenerateTaskTitle(cfg: SummarizerConfig, text: string, log: Logger): Promise<string> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
    case "zhipu":
    case "siliconflow":
    case "deepseek":
    case "moonshot":
    case "bailian":
    case "cohere":
    case "mistral":
    case "voyage":
      return generateTaskTitleOpenAI(text, cfg, log);
    case "anthropic":
      return generateTaskTitleAnthropic(text, cfg, log);
    case "gemini":
      return generateTaskTitleGemini(text, cfg, log);
    case "bedrock":
      return generateTaskTitleBedrock(text, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

function callTopicJudge(cfg: SummarizerConfig, currentContext: string, newMessage: string, log: Logger): Promise<boolean> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
    case "zhipu":
    case "siliconflow":
    case "deepseek":
    case "moonshot":
    case "bailian":
    case "cohere":
    case "mistral":
    case "voyage":
      return judgeNewTopicOpenAI(currentContext, newMessage, cfg, log);
    case "anthropic":
      return judgeNewTopicAnthropic(currentContext, newMessage, cfg, log);
    case "gemini":
      return judgeNewTopicGemini(currentContext, newMessage, cfg, log);
    case "bedrock":
      return judgeNewTopicBedrock(currentContext, newMessage, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

function callFilterRelevant(cfg: SummarizerConfig, query: string, candidates: Array<{ index: number; role: string; content: string; time?: string }>, log: Logger): Promise<FilterResult> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
    case "zhipu":
    case "siliconflow":
    case "deepseek":
    case "moonshot":
    case "bailian":
    case "cohere":
    case "mistral":
    case "voyage":
      return filterRelevantOpenAI(query, candidates, cfg, log);
    case "anthropic":
      return filterRelevantAnthropic(query, candidates, cfg, log);
    case "gemini":
      return filterRelevantGemini(query, candidates, cfg, log);
    case "bedrock":
      return filterRelevantBedrock(query, candidates, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

function callJudgeDedup(cfg: SummarizerConfig, newSummary: string, candidates: Array<{ index: number; summary: string; chunkId: string }>, log: Logger): Promise<DedupResult> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
    case "zhipu":
    case "siliconflow":
    case "deepseek":
    case "moonshot":
    case "bailian":
    case "cohere":
    case "mistral":
    case "voyage":
      return judgeDedupOpenAI(newSummary, candidates, cfg, log);
    case "anthropic":
      return judgeDedupAnthropic(newSummary, candidates, cfg, log);
    case "gemini":
      return judgeDedupGemini(newSummary, candidates, cfg, log);
    case "bedrock":
      return judgeDedupBedrock(newSummary, candidates, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

function callTopicClassifier(cfg: SummarizerConfig, taskState: string, newMessage: string, log: Logger): Promise<TopicClassifyResult> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
    case "zhipu":
    case "siliconflow":
    case "deepseek":
    case "moonshot":
    case "bailian":
    case "cohere":
    case "mistral":
    case "voyage":
      return classifyTopicOpenAI(taskState, newMessage, cfg, log);
    case "anthropic":
    case "gemini":
    case "bedrock":
      return classifyTopicOpenAI(taskState, newMessage, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

function callTopicArbitration(cfg: SummarizerConfig, taskState: string, newMessage: string, log: Logger): Promise<string> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
    case "zhipu":
    case "siliconflow":
    case "deepseek":
    case "moonshot":
    case "bailian":
    case "cohere":
    case "mistral":
    case "voyage":
      return arbitrateTopicSplitOpenAI(taskState, newMessage, cfg, log);
    case "anthropic":
    case "gemini":
    case "bedrock":
      return arbitrateTopicSplitOpenAI(taskState, newMessage, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

// ─── Fallbacks ───

function ruleFallback(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 5);
  return (lines[0] ?? text).trim();
}

function taskFallback(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 10);
  return lines.slice(0, 30).join("\n").slice(0, 2000);
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

/** Count "words": CJK characters count as 1 word each, latin words separated by spaces. */
function wordCount(text: string): number {
  let count = 0;
  const cjk = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
  const cjkMatches = text.match(cjk);
  if (cjkMatches) count += cjkMatches.length;
  const noCjk = text.replace(cjk, " ").trim();
  if (noCjk) count += noCjk.split(/\s+/).filter(Boolean).length;
  return count;
}
