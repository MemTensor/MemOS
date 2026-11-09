/**
 * Google Gemini generateContent API.
 *
 * Endpoint: POST <base>/models/<model>:generateContent?key=<KEY>
 *           POST <base>/models/<model>:streamGenerateContent?alt=sse&key=<KEY>
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { decodeSse, httpPostJson, httpPostStream } from "../fetcher.js";
import { sanitizeCompletionText } from "../sanitize.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmProviderCtx,
  LlmProviderName,
  LlmStreamChunk,
  ProviderCallInput,
  ProviderCompletion,
} from "../types.js";

interface GemCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}

interface GemResp {
  candidates?: GemCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export class GeminiLlmProvider implements LlmProvider {
  readonly name: LlmProviderName = "gemini";

  async complete(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
  ): Promise<ProviderCompletion> {
    const { config, log, signal, deadlineAt } = ctx;
    if (!config.apiKey) {
      throw new MemosError(
        ERROR_CODES.LLM_UNAVAILABLE,
        "gemini provider requires config.llm.apiKey",
        { provider: this.name },
      );
    }
    const model = config.model && config.model.length > 0 ? config.model : "gemini-1.5-flash";
    const base = getBase(config.endpoint);
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

    const body = buildGeminiBody(messages, opts);
    const { json, durationMs } = await httpPostJson<GemResp>({
      url,
      body,
      headers: { ...config.headers },
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      signal,
      deadlineAt,
      cooldownScope: config.model,
      provider: this.name,
      log,
    });

    const cand = json.candidates?.[0];
    const text = sanitizeCompletionText(
      cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "",
    );
    return {
      text,
      finishReason: mapFinish(cand?.finishReason),
      usage: json.usageMetadata
        ? {
            promptTokens: json.usageMetadata.promptTokenCount,
            completionTokens: json.usageMetadata.candidatesTokenCount,
            totalTokens: json.usageMetadata.totalTokenCount,
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
        "gemini provider requires config.llm.apiKey",
        { provider: this.name },
      );
    }
    const model = config.model && config.model.length > 0 ? config.model : "gemini-1.5-flash";
    const base = getBase(config.endpoint);
    const url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`;

    const body = buildGeminiBody(messages, opts);
    const resp = await httpPostStream({
      url,
      body,
      headers: { ...config.headers },
      timeoutMs: config.timeoutMs,
      signal,
      provider: this.name,
      log,
    });

    // Buffer the SSE deltas until the stream terminates, then sanitize the
    // full accumulated text before yielding it (issue #2336 follow-up).
    //
    // Rationale: `<think>...</think>` blocks and DeepSeek-style special
    // tokens can be split across chunk boundaries, so a naive per-chunk
    // `sanitizeCompletionText` would miss any artifact that straddles two
    // SSE events. Callers accumulate `chunk.delta` (see
    // `core/llm/client.ts::stream`), so we can safely emit one sanitized
    // delta at the tail: `chunks.map(c => c.delta).join("")` still yields
    // the sanitized full text, matching the contract exercised by the
    // provider tests.
    let done = false;
    let accumulated = "";
    let pendingUsage: GemResp["usageMetadata"] | undefined;
    for await (const payload of decodeSse(resp.body!)) {
      let evt: GemResp;
      try {
        evt = JSON.parse(payload) as GemResp;
      } catch {
        continue;
      }
      const cand = evt.candidates?.[0];
      const delta = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const finish = cand?.finishReason;
      if (delta.length > 0) accumulated += delta;
      if (evt.usageMetadata) pendingUsage = evt.usageMetadata;
      if (finish) {
        done = true;
        const sanitized = sanitizeCompletionText(accumulated);
        if (sanitized.length > 0) yield { delta: sanitized, done: false };
        const usage = evt.usageMetadata ?? pendingUsage;
        yield {
          delta: "",
          done: true,
          finishReason: mapFinish(finish),
          usage: usage
            ? {
                promptTokens: usage.promptTokenCount,
                completionTokens: usage.candidatesTokenCount,
                totalTokens: usage.totalTokenCount,
              }
            : undefined,
        };
        return;
      }
    }
    if (!done) {
      const sanitized = sanitizeCompletionText(accumulated);
      if (sanitized.length > 0) yield { delta: sanitized, done: false };
      yield {
        delta: "",
        done: true,
        usage: pendingUsage
          ? {
              promptTokens: pendingUsage.promptTokenCount,
              completionTokens: pendingUsage.candidatesTokenCount,
              totalTokens: pendingUsage.totalTokenCount,
            }
          : undefined,
      };
    }
  }
}

function getBase(endpoint: string | undefined): string {
  if (endpoint && endpoint.length > 0) return endpoint.replace(/\/+$/, "");
  return "https://generativelanguage.googleapis.com/v1beta";
}

function buildGeminiBody(messages: LlmMessage[], opts: ProviderCallInput): Record<string, unknown> {
  const systems: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      systems.push(m.content);
      continue;
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }
  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature,
    maxOutputTokens: opts.maxTokens,
  };
  if (opts.jsonMode) generationConfig.responseMimeType = "application/json";
  if (opts.stop && opts.stop.length > 0) generationConfig.stopSequences = opts.stop;
  const body: Record<string, unknown> = {
    contents,
    generationConfig,
  };
  if (systems.length > 0) {
    body.systemInstruction = { parts: [{ text: systems.join("\n\n") }] };
  }
  return body;
}

function mapFinish(reason: string | undefined): ProviderCompletion["finishReason"] {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case undefined:
    case null:
      return undefined;
    default:
      return "other";
  }
}
