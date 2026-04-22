/**
 * AWS Bedrock — Converse API.
 *
 * Endpoint is expected to be a Converse-style URL base; the actual path is
 * `${endpoint}/model/${model}/converse`.
 *
 * NOTE: Bedrock normally requires SigV4-signed requests. Users here are
 * expected to either run behind a proxy that signs, or provide a pre-signed
 * endpoint. Streaming is intentionally not implemented at this layer; call
 * sites that need tokens-per-second should route via a Converse-Stream proxy
 * with the `openai_compatible` provider pointed at it.
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { httpPostJson } from "../fetcher.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmProviderCtx,
  LlmProviderName,
  ProviderCallInput,
  ProviderCompletion,
} from "../types.js";

interface BedrockResp {
  output?: { message?: { content?: Array<{ text?: string }> } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export class BedrockLlmProvider implements LlmProvider {
  readonly name: LlmProviderName = "bedrock";

  async complete(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
  ): Promise<ProviderCompletion> {
    const { config, log, signal } = ctx;
    if (!config.endpoint || config.endpoint.length === 0) {
      throw new MemosError(
        ERROR_CODES.LLM_UNAVAILABLE,
        "bedrock provider requires config.llm.endpoint (Converse API base)",
        { provider: this.name },
      );
    }
    const model = config.model && config.model.length > 0
      ? config.model
      : "anthropic.claude-3-5-haiku-20241022-v1:0";

    const base = config.endpoint.replace(/\/+$/, "");
    const url = `${base}/model/${encodeURIComponent(model)}/converse`;

    const systems: Array<{ text: string }> = [];
    const msgs: Array<{ role: "user" | "assistant"; content: Array<{ text: string }> }> = [];
    for (const m of messages) {
      if (m.role === "system") {
        systems.push({ text: m.content });
      } else {
        msgs.push({
          role: m.role === "assistant" ? "assistant" : "user",
          content: [{ text: m.content }],
        });
      }
    }

    const body: Record<string, unknown> = {
      messages: msgs,
      inferenceConfig: {
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        ...(opts.stop && opts.stop.length > 0 ? { stopSequences: opts.stop } : {}),
      },
    };
    if (systems.length > 0) body.system = systems;

    const { json, durationMs } = await httpPostJson<BedrockResp>({
      url,
      body,
      headers: {
        // SigV4 is assumed to be applied by a proxy or forwarded via apiKey.
        ...(config.apiKey ? { Authorization: config.apiKey } : {}),
        ...config.headers,
      },
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      signal,
      provider: this.name,
      log,
    });

    const blocks = json.output?.message?.content ?? [];
    const text = blocks.map((b) => b.text ?? "").join("");
    return {
      text,
      finishReason: mapFinish(json.stopReason),
      usage: json.usage
        ? {
            promptTokens: json.usage.inputTokens,
            completionTokens: json.usage.outputTokens,
            totalTokens: json.usage.totalTokens,
          }
        : undefined,
      durationMs,
    };
  }
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
