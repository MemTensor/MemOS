/**
 * OpenAI-compatible chat completions.
 *
 * Endpoint: POST <endpoint>/chat/completions  { model, messages, ... }
 * Works with vanilla OpenAI and any drop-in API.
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { applyOpenRouterProviderRouting } from "../../openrouter.js";
import { decodeSse, httpPostJson, httpPostStream } from "../fetcher.js";
import { sanitizeCompletionText } from "../sanitize.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmProviderCtx,
  LlmProviderName,
  ReasoningConfig,
  LlmStreamChunk,
  ProviderCallInput,
  ProviderCompletion,
} from "../types.js";

interface OaChoice {
  message?: { content?: string };
  finish_reason?: string;
}

interface OaResp {
  choices?: OaChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OaStreamChoice {
  delta?: { content?: string };
  finish_reason?: string;
}

interface OaStreamResp {
  choices?: OaStreamChoice[];
  usage?: OaResp["usage"];
}

export class OpenAiLlmProvider implements LlmProvider {
  readonly name: LlmProviderName = "openai_compatible";

  async complete(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
  ): Promise<ProviderCompletion> {
    const { config, log, signal, deadlineAt } = ctx;
    const url = normalizeEndpoint(
      config.endpoint && config.endpoint.length > 0
        ? config.endpoint
        : "https://api.openai.com/v1/chat/completions",
    );
    const isLocal = isLocalhostOrPrivateUrl(url);
    if (!config.apiKey && !isLocal) {
      throw new MemosError(
        ERROR_CODES.LLM_UNAVAILABLE,
        "openai_compatible provider requires config.llm.apiKey (or use a local endpoint)",
        { provider: this.name },
      );
    }
    const model = config.model && config.model.length > 0 ? config.model : "gpt-4o-mini";

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    };
    if (opts.jsonMode) body.response_format = { type: "json_object" };
    if (opts.stop && opts.stop.length > 0) body.stop = opts.stop;
    if (applyOpenRouterProviderRouting(config, body)) {
      const reasoning = config.reasoning && serializeOpenRouterReasoning(config.reasoning);
      if (reasoning) body.reasoning = reasoning;
    }

    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
    Object.assign(headers, config.headers);

    const { json, durationMs } = await httpPostJson<OaResp>({
      url,
      body,
      headers,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      signal,
      deadlineAt,
      cooldownScope: config.model,
      provider: this.name,
      log,
    });

    const choice = json.choices?.[0];
    const text = sanitizeCompletionText(choice?.message?.content ?? "");
    return {
      text,
      finishReason: mapFinish(choice?.finish_reason),
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          }
        : undefined,
      durationMs,
    };
  }

  async *stream(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
  ): AsyncGenerator<LlmStreamChunk> {
    const { config, log, signal } = ctx;
    const url = normalizeEndpoint(
      config.endpoint && config.endpoint.length > 0
        ? config.endpoint
        : "https://api.openai.com/v1/chat/completions",
    );
    const isLocal = isLocalhostOrPrivateUrl(url);
    if (!config.apiKey && !isLocal) {
      throw new MemosError(
        ERROR_CODES.LLM_UNAVAILABLE,
        "openai_compatible provider requires config.llm.apiKey (or use a local endpoint)",
        { provider: this.name },
      );
    }
    const model = config.model && config.model.length > 0 ? config.model : "gpt-4o-mini";

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      stream: true,
    };
    if (opts.jsonMode) body.response_format = { type: "json_object" };
    if (opts.stop && opts.stop.length > 0) body.stop = opts.stop;
    if (applyOpenRouterProviderRouting(config, body)) {
      const reasoning = config.reasoning && serializeOpenRouterReasoning(config.reasoning);
      if (reasoning) body.reasoning = reasoning;
    }

    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
    Object.assign(headers, config.headers);

    const resp = await httpPostStream({
      url,
      body,
      headers,
      timeoutMs: config.timeoutMs,
      signal,
      provider: this.name,
      log,
    });

    // Buffer the SSE deltas until the stream terminates, then sanitize the
    // full accumulated text before yielding it (issue #2336 follow-up).
    //
    // Rationale: `<think>...</think>` blocks and DeepSeek special tokens
    // (`<｜end▁of▁sentence｜>`, etc.) can be split across chunk boundaries,
    // so a naive per-chunk `sanitizeCompletionText` would miss any artifact
    // that straddles two SSE events. Callers accumulate `chunk.delta` (see
    // `core/llm/client.ts::stream`), so we can safely emit one sanitized
    // delta at the tail: `chunks.map(c => c.delta).join("")` still yields
    // the sanitized full text, matching the contract exercised by the
    // provider tests.
    let emittedDone = false;
    let accumulated = "";
    let pendingUsage: OaResp["usage"] | undefined;
    for await (const payload of decodeSse(resp.body!)) {
      if (payload === "[DONE]") {
        if (!emittedDone) {
          emittedDone = true;
          const sanitized = sanitizeCompletionText(accumulated);
          if (sanitized.length > 0) yield { delta: sanitized, done: false };
          yield {
            delta: "",
            done: true,
            usage: pendingUsage
              ? {
                  promptTokens: pendingUsage.prompt_tokens,
                  completionTokens: pendingUsage.completion_tokens,
                  totalTokens: pendingUsage.total_tokens,
                }
              : undefined,
          };
        }
        return;
      }
      let parsed: OaStreamResp | null = null;
      try {
        parsed = JSON.parse(payload) as OaStreamResp;
      } catch {
        // Provider occasionally sends keepalive lines — ignore.
        continue;
      }
      const choice = parsed.choices?.[0];
      const delta = choice?.delta?.content ?? "";
      const finish = choice?.finish_reason;
      if (delta.length > 0) {
        accumulated += delta;
      }
      if (parsed.usage) pendingUsage = parsed.usage;
      if (finish) {
        emittedDone = true;
        const sanitized = sanitizeCompletionText(accumulated);
        if (sanitized.length > 0) yield { delta: sanitized, done: false };
        const usage = parsed.usage ?? pendingUsage;
        yield {
          delta: "",
          done: true,
          finishReason: mapFinish(finish),
          usage: usage
            ? {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
              }
            : undefined,
        };
        return;
      }
    }
    if (!emittedDone) {
      const sanitized = sanitizeCompletionText(accumulated);
      if (sanitized.length > 0) yield { delta: sanitized, done: false };
      yield {
        delta: "",
        done: true,
        usage: pendingUsage
          ? {
              promptTokens: pendingUsage.prompt_tokens,
              completionTokens: pendingUsage.completion_tokens,
              totalTokens: pendingUsage.total_tokens,
            }
          : undefined,
      };
    }
  }
}

function normalizeEndpoint(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (stripped.endsWith("/chat/completions")) return stripped;
  if (stripped.endsWith("/completions")) return stripped;
  return `${stripped}/chat/completions`;
}

function serializeOpenRouterReasoning(reasoning: ReasoningConfig): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  if (reasoning.enabled !== undefined) result.enabled = reasoning.enabled;
  if (reasoning.effort !== undefined) result.effort = reasoning.effort;
  if (reasoning.maxTokens !== undefined) result.max_tokens = reasoning.maxTokens;
  return Object.keys(result).length > 0 ? result : undefined;
}

function mapFinish(reason: string | undefined): ProviderCompletion["finishReason"] {
  switch (reason) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case undefined:
    case null:
      return undefined;
    default:
      return "other";
  }
}

/**
 * Return true if the URL points to localhost or a private-network address.
 * Used to relax the apiKey requirement for local/self-hosted inference servers.
 */
function isLocalhostOrPrivateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
    // Private ranges: 10.x, 172.16-31.x, 192.168.x
    if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
    const m = h.match(/^172\.(\d+)\./);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 16 && n <= 31) return true;
    }
  } catch {
    // Malformed URL — let the caller handle it.
  }
  return false;
}
