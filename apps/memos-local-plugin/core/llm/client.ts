/**
 * `LlmClient` — the only surface the rest of `core/` sees.
 *
 * Responsibilities:
 *   - Pick a provider from config.
 *   - Normalize `string | LlmMessage[]` inputs.
 *   - Inject JSON-mode system hints when the provider has no native mode.
 *   - Parse JSON output with `parseLlmJson` + optional schema validation,
 *     with a small (default 1) malformed-retry budget.
 *   - Host fallback: when the primary provider throws LLM_UNAVAILABLE /
 *     LLM_RATE_LIMITED / LLM_TIMEOUT and `config.fallbackToHost=true` AND
 *     the adapter has registered a `HostLlmBridge`, retry once via host.
 *   - Structured audit via `log.llm({...})` for every successful call.
 *   - Stream: provider-native when available, otherwise wrap `complete` in a
 *     single-chunk iterable so call sites don't have to branch.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import { rootLogger } from "../logger/index.js";
import type { Logger } from "../logger/types.js";
import { getHostLlmBridge } from "./host-bridge.js";
import { buildJsonSystemHint, parseLlmJson } from "./json-mode.js";
import { AnthropicLlmProvider } from "./providers/anthropic.js";
import { BedrockLlmProvider } from "./providers/bedrock.js";
import { GeminiLlmProvider } from "./providers/gemini.js";
import { HostLlmProvider } from "./providers/host.js";
import { LocalOnlyLlmProvider } from "./providers/local-only.js";
import { OpenAiLlmProvider } from "./providers/openai.js";
import type {
  LlmCallOptions,
  LlmClient,
  LlmClientStats,
  LlmCompleteJsonOptions,
  LlmCompletion,
  LlmConfig,
  LlmJsonCompletion,
  LlmMessage,
  LlmProvider,
  LlmProviderCtx,
  LlmProviderLogger,
  LlmProviderName,
  LlmStreamChunk,
  ProviderCallInput,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 1024;

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createLlmClient(config: LlmConfig): LlmClient {
  const provider = makeProviderFor(config.provider);
  return createLlmClientWithProvider(config, provider);
}

export function createLlmClientWithProvider(
  config: LlmConfig,
  provider: LlmProvider,
): LlmClient {
  const facadeLog = rootLogger.child({ channel: "llm" });
  const providerChannel = `llm.${provider.name}` as const;
  const providerLog = rootLogger.child({ channel: providerChannel });
  const jsonLog = rootLogger.child({ channel: "llm.json" });

  let requests = 0;
  let hostFallbacks = 0;
  let failures = 0;
  let retries = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let lastOkAt: number | null = null;
  let lastError: { at: number; message: string } | null = null;

  function markOk(): void {
    lastOkAt = Date.now();
    lastError = null;
  }
  function markFail(err: unknown): void {
    lastError = { at: Date.now(), message: summarizeErrMessage(err) };
  }

  function normalizeMessages(input: LlmMessage[] | string): LlmMessage[] {
    if (typeof input === "string") return [{ role: "user", content: input }];
    if (!Array.isArray(input) || input.length === 0) {
      throw new MemosError(ERROR_CODES.INVALID_ARGUMENT, "LLM messages array is empty");
    }
    return input;
  }

  function inject(messages: LlmMessage[], systemInsert: string): LlmMessage[] {
    if (!systemInsert) return messages;
    // Merge into existing top system if present, otherwise prepend.
    if (messages[0]?.role === "system") {
      return [
        { role: "system", content: `${messages[0].content}\n\n${systemInsert}` },
        ...messages.slice(1),
      ];
    }
    return [{ role: "system", content: systemInsert }, ...messages];
  }

  function buildCallInput(opts: LlmCallOptions | undefined, jsonMode: boolean): ProviderCallInput {
    return {
      temperature: opts?.temperature ?? config.temperature,
      maxTokens: opts?.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
      jsonMode,
      stop: opts?.stop,
    };
  }

  function makeCtx(opts: LlmCallOptions | undefined, pLog: LlmProviderLogger): LlmProviderCtx {
    return {
      config: {
        ...config,
        timeoutMs: opts?.timeoutMs ?? config.timeoutMs,
      },
      log: pLog,
      signal: opts?.signal,
    };
  }

  async function callWithFallback(
    messages: LlmMessage[],
    input: ProviderCallInput,
    opts: LlmCallOptions | undefined,
    op: string,
  ): Promise<{ completion: LlmCompletion }> {
    requests++;
    try {
      const raw = await provider.complete(messages, input, makeCtx(opts, asProviderLog(providerLog)));
      const completion: LlmCompletion = {
        text: raw.text,
        provider: provider.name,
        model: config.model,
        finishReason: raw.finishReason,
        usage: raw.usage,
        servedBy: provider.name,
        durationMs: raw.durationMs,
      };
      record(completion, op, messages);
      markOk();
      return { completion };
    } catch (err) {
      if (shouldFallback(err, config, provider.name)) {
        const hostProv = new HostLlmProvider();
        try {
          const res = await hostProv.complete(messages, input, makeCtx(opts, asProviderLog(rootLogger.child({ channel: "llm.host" }))));
          hostFallbacks++;
          facadeLog.warn("host.fallback", {
            from: provider.name,
            op,
            reason: summarizeErr(err),
          });
          const completion: LlmCompletion = {
            text: res.text,
            provider: provider.name,
            model: config.model,
            finishReason: res.finishReason,
            usage: res.usage,
            servedBy: "host_fallback",
            durationMs: res.durationMs,
          };
          record(completion, op, messages);
          markOk();
          return { completion };
        } catch (hostErr) {
          failures++;
          markFail(hostErr);
          facadeLog.error("host.fallback_failed", {
            primary: summarizeErr(err),
            host: summarizeErr(hostErr),
          });
          throw hostErr instanceof MemosError
            ? hostErr
            : new MemosError(
                ERROR_CODES.LLM_UNAVAILABLE,
                `host fallback failed: ${(hostErr as Error).message ?? String(hostErr)}`,
              );
        }
      }
      failures++;
      markFail(err);
      throw err instanceof MemosError
        ? err
        : new MemosError(
            ERROR_CODES.LLM_UNAVAILABLE,
            `${provider.name} failed: ${(err as Error).message ?? String(err)}`,
            { provider: provider.name },
          );
    }
  }

  function record(completion: LlmCompletion, op: string, messages: LlmMessage[]): void {
    if (completion.usage?.promptTokens) totalPromptTokens += completion.usage.promptTokens;
    if (completion.usage?.completionTokens) totalCompletionTokens += completion.usage.completionTokens;
    facadeLog.llm({
      provider: completion.provider,
      model: completion.model,
      op,
      ms: completion.durationMs,
      promptTokens: completion.usage?.promptTokens,
      completionTokens: completion.usage?.completionTokens,
      totalTokens: completion.usage?.totalTokens,
      status: "ok",
      // Prompt redaction is handled inside `log.llm` based on config —
      // we pass the first ~200 chars of each message as a compact echo.
      prompt: messages.map((m) => `${m.role}: ${m.content.slice(0, 200)}`).join("\n"),
      completion: completion.text.slice(0, 1000),
    });
  }

  async function complete(
    input: LlmMessage[] | string,
    opts?: LlmCallOptions,
  ): Promise<LlmCompletion> {
    const messages = normalizeMessages(input);
    const msgsWithJsonHint = opts?.jsonMode
      ? inject(messages, buildJsonSystemHint())
      : messages;
    const call = buildCallInput(opts, opts?.jsonMode === true);
    const { completion } = await callWithFallback(msgsWithJsonHint, call, opts, opts?.op ?? "complete");
    return completion;
  }

  async function completeJson<T>(
    input: LlmMessage[] | string,
    opts: LlmCompleteJsonOptions<T> = {},
  ): Promise<LlmJsonCompletion<T>> {
    const messages = normalizeMessages(input);
    const systemHint = buildJsonSystemHint(opts.schemaHint);
    const msgs = inject(messages, systemHint);
    const call = buildCallInput(opts, true);
    const op = opts.op ?? "complete.json";
    const maxMalformedRetries = Math.max(0, opts.malformedRetries ?? 1);
    let attempt = 0;
    let lastRaw = "";
    let lastErr: unknown = null;

    while (attempt <= maxMalformedRetries) {
      attempt++;
      const { completion } = await callWithFallback(msgs, call, opts, op);
      lastRaw = completion.text;
      try {
        const parsed = opts.parse
          ? opts.parse(completion.text)
          : parseLlmJson<T>(completion.text, { provider: provider.name, op });
        // `validate` is an `asserts` function; calling it through a nullable
        // property loses the assertion type. Cast through `unknown` so TS
        // doesn't try to narrow the call target.
        if (opts.validate) {
          (opts.validate as (v: unknown) => void)(parsed);
        }
        return {
          value: parsed,
          raw: completion.text,
          provider: completion.provider,
          model: completion.model,
          finishReason: completion.finishReason,
          usage: completion.usage,
          servedBy: completion.servedBy,
          durationMs: completion.durationMs,
        };
      } catch (err) {
        lastErr = err;
        jsonLog.warn("malformed", {
          op,
          attempt,
          err: summarizeErr(err),
        });
        if (attempt <= maxMalformedRetries) {
          retries++;
          continue;
        }
      }
    }

    throw lastErr instanceof MemosError
      ? lastErr
      : new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, "LLM JSON unparseable after retries", {
          provider: provider.name,
          op,
          rawPreview: lastRaw.slice(0, 512),
        });
  }

  async function* stream(
    input: LlmMessage[] | string,
    opts?: LlmCallOptions,
  ): AsyncGenerator<LlmStreamChunk> {
    const messages = normalizeMessages(input);
    const call = buildCallInput(opts, opts?.jsonMode === true);
    const ctx = makeCtx(opts, asProviderLog(providerLog));

    requests++;
    const start = Date.now();
    let acc = "";
    let usage: LlmCompletion["usage"];
    try {
      if (typeof provider.stream === "function") {
        for await (const chunk of provider.stream(messages, call, ctx)) {
          if (chunk.delta) acc += chunk.delta;
          if (chunk.usage) usage = chunk.usage;
          yield chunk;
        }
      } else {
        const raw = await provider.complete(messages, call, ctx);
        acc = raw.text;
        usage = raw.usage;
        yield { delta: raw.text, done: false };
        yield { delta: "", done: true, usage };
      }
      facadeLog.llm({
        provider: provider.name,
        model: config.model,
        op: opts?.op ?? "stream",
        ms: Date.now() - start,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        totalTokens: usage?.totalTokens,
        status: "ok",
        prompt: messages.map((m) => `${m.role}: ${m.content.slice(0, 200)}`).join("\n"),
        completion: acc.slice(0, 1000),
      });
      if (usage?.promptTokens) totalPromptTokens += usage.promptTokens;
      if (usage?.completionTokens) totalCompletionTokens += usage.completionTokens;
      markOk();
    } catch (err) {
      failures++;
      markFail(err);
      facadeLog.error("stream.failed", { err: summarizeErr(err) });
      throw err;
    }
  }

  const client: LlmClient = {
    provider: provider.name,
    model: config.model,
    canStream: typeof provider.stream === "function",
    complete,
    completeJson,
    stream,
    stats(): LlmClientStats {
      return {
        requests,
        hostFallbacks,
        failures,
        retries,
        totalPromptTokens,
        totalCompletionTokens,
        lastOkAt,
        lastError,
      };
    },
    resetStats(): void {
      requests = 0;
      hostFallbacks = 0;
      failures = 0;
      retries = 0;
      totalPromptTokens = 0;
      totalCompletionTokens = 0;
      lastOkAt = null;
      lastError = null;
    },
    async close(): Promise<void> {
      await provider.close?.();
    },
  };

  facadeLog.info("init", {
    provider: provider.name,
    model: config.model,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    fallbackToHost: config.fallbackToHost,
  });

  return client;
}

// ─── Provider selection + fallback logic ─────────────────────────────────────

export function makeProviderFor(name: LlmProviderName): LlmProvider {
  switch (name) {
    case "openai_compatible":
      return new OpenAiLlmProvider();
    case "anthropic":
      return new AnthropicLlmProvider();
    case "gemini":
      return new GeminiLlmProvider();
    case "bedrock":
      return new BedrockLlmProvider();
    case "host":
      return new HostLlmProvider();
    case "local_only":
      return new LocalOnlyLlmProvider();
    default:
      throw new MemosError(ERROR_CODES.UNSUPPORTED, `Unknown llm provider: ${String(name)}`, {
        provider: name,
      });
  }
}

function shouldFallback(err: unknown, config: LlmConfig, providerName: LlmProviderName): boolean {
  if (!config.fallbackToHost) return false;
  if (providerName === "host") return false; // already host
  if (!getHostLlmBridge()) return false;
  if (!(err instanceof MemosError)) return false;
  return (
    err.code === ERROR_CODES.LLM_UNAVAILABLE ||
    err.code === ERROR_CODES.LLM_RATE_LIMITED ||
    err.code === ERROR_CODES.LLM_TIMEOUT
  );
}

// ─── Logger adapter ──────────────────────────────────────────────────────────

function asProviderLog(log: Logger): LlmProviderLogger {
  return {
    trace: (msg, detail) => log.trace(msg, detail),
    debug: (msg, detail) => log.debug(msg, detail),
    info: (msg, detail) => log.info(msg, detail),
    warn: (msg, detail) => log.warn(msg, detail),
    error: (msg, detail) => log.error(msg, detail),
  };
}

function summarizeErr(e: unknown): Record<string, unknown> {
  if (e instanceof MemosError) return { ...e.toJSON() };
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { value: String(e) };
}

function summarizeErrMessage(e: unknown): string {
  if (e instanceof MemosError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
