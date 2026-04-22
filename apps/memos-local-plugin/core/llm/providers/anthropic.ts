/**
 * Anthropic Messages API.
 *
 * Endpoint: POST <endpoint>/v1/messages  { model, messages, system?, ... }
 * Streaming: SSE events named `content_block_delta` with `{ delta: { text } }`.
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { decodeSse, httpPostJson, httpPostStream } from "../fetcher.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmProviderCtx,
  LlmProviderName,
  LlmStreamChunk,
  ProviderCallInput,
  ProviderCompletion,
} from "../types.js";

interface AnthResp {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly name: LlmProviderName = "anthropic";

  async complete(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
  ): Promise<ProviderCompletion> {
    const { config, log, signal } = ctx;
    if (!config.apiKey) {
      throw new MemosError(
        ERROR_CODES.LLM_UNAVAILABLE,
        "anthropic provider requires config.llm.apiKey",
        { provider: this.name },
      );
    }
    const url = normalizeEndpoint(
      config.endpoint && config.endpoint.length > 0
        ? config.endpoint
        : "https://api.anthropic.com/v1/messages",
    );
    const model = config.model && config.model.length > 0 ? config.model : "claude-3-5-haiku-latest";

    const { system, userMsgs } = splitSystem(messages);
    const body: Record<string, unknown> = {
      model,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      messages: userMsgs,
    };
    if (system.length > 0) body.system = system;
    if (opts.stop && opts.stop.length > 0) body.stop_sequences = opts.stop;
    // Anthropic has no "JSON mode"; json-mode.ts injects a system hint instead.

    const { json, durationMs } = await httpPostJson<AnthResp>({
      url,
      body,
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        ...config.headers,
      },
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      signal,
      provider: this.name,
      log,
    });

    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");
    return {
      text,
      finishReason: mapFinish(json.stop_reason),
      usage: json.usage
        ? {
            promptTokens: json.usage.input_tokens,
            completionTokens: json.usage.output_tokens,
            totalTokens:
              (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0) || undefined,
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
    if (!config.apiKey) {
      throw new MemosError(
        ERROR_CODES.LLM_UNAVAILABLE,
        "anthropic provider requires config.llm.apiKey",
        { provider: this.name },
      );
    }
    const url = normalizeEndpoint(
      config.endpoint && config.endpoint.length > 0
        ? config.endpoint
        : "https://api.anthropic.com/v1/messages",
    );
    const model = config.model && config.model.length > 0 ? config.model : "claude-3-5-haiku-latest";

    const { system, userMsgs } = splitSystem(messages);
    const body: Record<string, unknown> = {
      model,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      messages: userMsgs,
      stream: true,
    };
    if (system.length > 0) body.system = system;
    if (opts.stop && opts.stop.length > 0) body.stop_sequences = opts.stop;

    const resp = await httpPostStream({
      url,
      body,
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        ...config.headers,
      },
      timeoutMs: config.timeoutMs,
      signal,
      provider: this.name,
      log,
    });

    let done = false;
    for await (const payload of decodeSse(resp.body!)) {
      let evt: { type?: string; delta?: { text?: string; stop_reason?: string }; usage?: AnthResp["usage"] };
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      if (evt.type === "content_block_delta" && evt.delta?.text) {
        yield { delta: evt.delta.text, done: false };
      } else if (evt.type === "message_delta") {
        const reason = evt.delta?.stop_reason;
        if (reason) {
          done = true;
          yield {
            delta: "",
            done: true,
            finishReason: mapFinish(reason),
            usage: evt.usage
              ? {
                  promptTokens: evt.usage.input_tokens,
                  completionTokens: evt.usage.output_tokens,
                }
              : undefined,
          };
        }
      } else if (evt.type === "message_stop") {
        if (!done) {
          done = true;
          yield { delta: "", done: true };
        }
        return;
      }
    }
    if (!done) yield { delta: "", done: true };
  }
}

function normalizeEndpoint(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (stripped.endsWith("/v1/messages")) return stripped;
  if (stripped.endsWith("/messages")) return stripped;
  return `${stripped}/v1/messages`;
}

function splitSystem(messages: LlmMessage[]): { system: string; userMsgs: LlmMessage[] } {
  const systems: string[] = [];
  const others: LlmMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") systems.push(m.content);
    else others.push(m);
  }
  return { system: systems.join("\n\n"), userMsgs: others };
}

function mapFinish(reason: string | undefined): ProviderCompletion["finishReason"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case undefined:
    case null:
      return undefined;
    default:
      return "other";
  }
}
