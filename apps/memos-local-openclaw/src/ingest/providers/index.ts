import * as fs from "fs";
import type { SummarizerConfig, Logger } from "../../types";
import { getOpenClawConfigPath } from "../../config";
import { summarizeOpenAI, summarizeTaskOpenAI, judgeNewTopicOpenAI, filterRelevantOpenAI, judgeDedupOpenAI } from "./openai";
import type { FilterResult, DedupResult } from "./openai";
export type { FilterResult, DedupResult } from "./openai";
import { summarizeAnthropic, summarizeTaskAnthropic, judgeNewTopicAnthropic, filterRelevantAnthropic, judgeDedupAnthropic } from "./anthropic";
import { summarizeGemini, summarizeTaskGemini, judgeNewTopicGemini, filterRelevantGemini, judgeDedupGemini } from "./gemini";
import { summarizeBedrock, summarizeTaskBedrock, judgeNewTopicBedrock, filterRelevantBedrock, judgeDedupBedrock } from "./bedrock";

/**
 * Build a SummarizerConfig from OpenClaw's native model configuration (openclaw.json).
 * This serves as the final fallback when both strongCfg and plugin summarizer fail or are absent.
 */
export function loadOpenClawFallbackConfig(log: Logger, stateDir?: string): SummarizerConfig | undefined {
  try {
    const cfgPath = getOpenClawConfigPath(stateDir);
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
    const apiKey: string | undefined = providerCfg.apiKey;
    if (!baseUrl || !apiKey) return undefined;

    const endpoint = baseUrl.endsWith("/chat/completions")
      ? baseUrl
      : baseUrl.replace(/\/+$/, "") + "/chat/completions";

    log.debug(`OpenClaw fallback model: ${modelId} via ${baseUrl}`);
    return {
      provider: "openai_compatible",
      endpoint,
      apiKey,
      model: modelId,
    };
  } catch (err) {
    log.debug(`Failed to load OpenClaw fallback config: ${err}`);
    return undefined;
  }
}

export class Summarizer {
  private strongCfg: SummarizerConfig | undefined;
  private fallbackCfg: SummarizerConfig | undefined;

  constructor(
    private cfg: SummarizerConfig | undefined,
    private log: Logger,
    strongCfg?: SummarizerConfig,
    stateDir?: string,
  ) {
    this.strongCfg = strongCfg;
    this.fallbackCfg = loadOpenClawFallbackConfig(log, stateDir);
  }

  /**
   * Ordered config chain: strongCfg → cfg → fallbackCfg (OpenClaw native model).
   * Returns configs that are defined, in priority order.
   */
  private getConfigChain(): SummarizerConfig[] {
    const chain: SummarizerConfig[] = [];
    if (this.strongCfg) chain.push(this.strongCfg);
    if (this.cfg) chain.push(this.cfg);
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
      try {
        return await fn(chain[i]);
      } catch (err) {
        const level = i < chain.length - 1 ? "warn" : "error";
        const modelInfo = `${chain[i].provider}/${chain[i].model ?? "?"}`;
        this.log[level](`${label} failed (${modelInfo}), ${i < chain.length - 1 ? "trying next" : "no more fallbacks"}: ${err}`);
      }
    }
    return undefined;
  }

  async summarize(text: string): Promise<string> {
    if (!this.cfg && !this.fallbackCfg) {
      return ruleFallback(text);
    }

    const result = await this.tryChain("summarize", (cfg) => callSummarize(cfg, text, this.log));
    return result ?? ruleFallback(text);
  }

  async summarizeTask(text: string): Promise<string> {
    if (!this.cfg && !this.fallbackCfg) {
      return taskFallback(text);
    }

    const result = await this.tryChain("summarizeTask", (cfg) => callSummarizeTask(cfg, text, this.log));
    return result ?? taskFallback(text);
  }

  async judgeNewTopic(currentContext: string, newMessage: string): Promise<boolean | null> {
    if (!this.cfg && !this.fallbackCfg) return null;

    const result = await this.tryChain("judgeNewTopic", (cfg) => callTopicJudge(cfg, currentContext, newMessage, this.log));
    return result ?? null;
  }

  async filterRelevant(
    query: string,
    candidates: Array<{ index: number; summary: string; role: string }>,
  ): Promise<FilterResult | null> {
    if (!this.cfg && !this.fallbackCfg) return null;
    if (candidates.length === 0) return { relevant: [], sufficient: true };

    const result = await this.tryChain("filterRelevant", (cfg) => callFilterRelevant(cfg, query, candidates, this.log));
    return result ?? null;
  }

  async judgeDedup(
    newSummary: string,
    candidates: Array<{ index: number; summary: string; chunkId: string }>,
  ): Promise<DedupResult | null> {
    if (!this.cfg && !this.fallbackCfg) return null;
    if (candidates.length === 0) return null;

    const result = await this.tryChain("judgeDedup", (cfg) => callJudgeDedup(cfg, newSummary, candidates, this.log));
    return result ?? { action: "NEW", reason: "all_models_failed" };
  }

  getStrongConfig(): SummarizerConfig | undefined {
    return this.strongCfg;
  }
}

// ─── Dispatch helpers ───

function callSummarize(cfg: SummarizerConfig, text: string, log: Logger): Promise<string> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
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

function callTopicJudge(cfg: SummarizerConfig, currentContext: string, newMessage: string, log: Logger): Promise<boolean> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
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

function callFilterRelevant(cfg: SummarizerConfig, query: string, candidates: Array<{ index: number; summary: string; role: string }>, log: Logger): Promise<FilterResult> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
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

// ─── Fallbacks ───

function taskFallback(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 10);
  return lines.slice(0, 30).join("\n").slice(0, 2000);
}

function ruleFallback(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 10);
  const first = (lines[0] ?? text).trim();

  const entityRe = [/`[^`]+`/g, /\b(?:error|Error|ERROR)\s*[:：]\s*.{5,60}/g];
  const entities: string[] = [];
  for (const re of entityRe) {
    for (const m of text.matchAll(re)) {
      if (entities.length < 3) entities.push(m[0].slice(0, 50));
    }
  }

  let summary = first.length > 120 ? first.slice(0, 117) + "..." : first;
  if (entities.length > 0) {
    summary += ` (${entities.join(", ")})`;
  }
  return summary.slice(0, 200);
}
