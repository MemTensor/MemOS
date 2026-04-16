import * as fs from "fs";
import * as path from "path";
import type { SummarizerConfig, SummaryProvider, Logger, PluginContext, OpenClawAPI } from "../types";

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
function detectProvider(providerKey: string | undefined, baseUrl: string): SummaryProvider {
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
 * Return the correct default endpoint for a given provider.
 */
function defaultEndpointForProvider(provider: SummaryProvider, baseUrl: string): string {
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
 * Final fallback when both strongCfg and plugin summarizer fail or are absent.
 */
export function loadOpenClawFallbackConfig(log: Logger): SummarizerConfig | undefined {
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
    const endpoint = defaultEndpointForProvider(provider, baseUrl);

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

/**
 * Build the ordered fallback chain for skill-related LLM calls:
 *   skillEvolution.summarizer → plugin summarizer → OpenClaw native model
 */
export function buildSkillConfigChain(ctx: PluginContext): SummarizerConfig[] {
  const chain: SummarizerConfig[] = [];
  const skillCfg = ctx.config.skillEvolution?.summarizer;
  const pluginCfg = ctx.config.summarizer;
  const fallbackCfg = loadOpenClawFallbackConfig(ctx.log);
  if (skillCfg) chain.push(skillCfg);
  if (pluginCfg && pluginCfg !== skillCfg) chain.push(pluginCfg);
  if (fallbackCfg) chain.push(fallbackCfg);
  return chain;
}

export interface LLMCallOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Pass ctx.openclawAPI so callLLMOnce can handle provider === "openclaw" */
  openclawAPI?: OpenClawAPI;
}

function normalizeOpenAIEndpoint(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (stripped.endsWith("/chat/completions")) return stripped;
  if (stripped.endsWith("/completions")) return stripped;
  return `${stripped}/chat/completions`;
}

function normalizeAnthropicEndpoint(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (stripped.endsWith("/v1/messages")) return stripped;
  if (stripped.endsWith("/messages")) return stripped;
  return `${stripped}/v1/messages`;
}

function isAnthropicProvider(cfg: SummarizerConfig): boolean {
  return cfg.provider === "anthropic";
}

/**
 * Make a single LLM call with the given config. Throws on failure.
 * When cfg.provider === "openclaw", delegates to the OpenClaw host completion API.
 * Dispatches to Anthropic or OpenAI-compatible format based on provider.
 */
export async function callLLMOnce(
  cfg: SummarizerConfig,
  prompt: string,
  opts: LLMCallOptions = {},
): Promise<string> {
  if (cfg.provider === "openclaw") {
    const api = opts.openclawAPI;
    if (!api) {
      throw new Error("OpenClaw API not available. Ensure sharing.capabilities.hostCompletion is enabled.");
    }
    const response = await api.complete({
      prompt,
      maxTokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.1,
      model: cfg.model,
    });
    return response.text.trim();
  }

  if (isAnthropicProvider(cfg)) {
    return callLLMOnceAnthropic(cfg, prompt, opts);
  }
  return callLLMOnceOpenAI(cfg, prompt, opts);
}

async function callLLMOnceAnthropic(
  cfg: SummarizerConfig,
  prompt: string,
  opts: LLMCallOptions = {},
): Promise<string> {
  const endpoint = normalizeAnthropicEndpoint(
    cfg.endpoint ?? "https://api.anthropic.com/v1/messages",
  );
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
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 1024,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`LLM call failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { content: Array<{ type: string; text: string }> };
  return json.content.find((c) => c.type === "text")?.text?.trim() ?? "";
}

async function callLLMOnceOpenAI(
  cfg: SummarizerConfig,
  prompt: string,
  opts: LLMCallOptions = {},
): Promise<string> {
  const endpoint = normalizeOpenAIEndpoint(
    cfg.endpoint ?? "https://api.openai.com/v1/chat/completions",
  );
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 1024,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`LLM call failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * Call LLM with fallback chain: tries each config in order until one succeeds.
 * Returns the result string, or throws if ALL configs fail.
 */
export async function callLLMWithFallback(
  chain: SummarizerConfig[],
  prompt: string,
  log: Logger,
  label: string,
  opts: LLMCallOptions = {},
): Promise<string> {
  if (chain.length === 0) {
    throw new Error(`${label}: no LLM config available`);
  }

  for (let i = 0; i < chain.length; i++) {
    try {
      return await callLLMOnce(chain[i], prompt, opts);
    } catch (err) {
      const modelInfo = `${chain[i].provider ?? "?"}/${chain[i].model ?? "?"}`;
      if (i < chain.length - 1) {
        log.warn(`${label} failed (${modelInfo}), trying next fallback: ${err}`);
      } else {
        log.error(`${label} failed (${modelInfo}), no more fallbacks: ${err}`);
        throw err;
      }
    }
  }
  throw new Error(`${label}: all models failed`);
}
