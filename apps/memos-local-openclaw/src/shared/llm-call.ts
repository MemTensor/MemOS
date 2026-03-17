import * as fs from "fs";
import * as path from "path";
import type { SummarizerConfig, Logger, PluginContext } from "../types";

/**
 * Build a SummarizerConfig from OpenClaw's native model configuration (openclaw.json).
 * Final fallback when both strongCfg and plugin summarizer fail or are absent.
 */
export function loadOpenClawFallbackConfig(log: Logger): SummarizerConfig | undefined {
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const cfgPath = path.join(home, ".openclaw", "openclaw.json");
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
}

function normalizeEndpoint(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (stripped.endsWith("/chat/completions")) return stripped;
  if (stripped.endsWith("/completions")) return stripped;
  return `${stripped}/chat/completions`;
}

/**
 * Make a single LLM call with the given config. Throws on failure.
 */
export async function callLLMOnce(
  cfg: SummarizerConfig,
  prompt: string,
  opts: LLMCallOptions = {},
): Promise<string> {
  const endpoint = normalizeEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
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
