/**
 * Minimal deterministic LLM for tests. Does NOT hit the network.
 *
 * Two factories:
 *   - `fakeLlm(config)` — scripted responses keyed by `op`.
 *   - `flakyLlm({failFirst, then})` — fails N times, then responds.
 */

import type {
  LlmClient,
  LlmClientStats,
  LlmCompletion,
  LlmJsonCompletion,
  LlmProviderName,
  LlmStreamChunk,
} from "../../core/llm/types.js";

export interface FakeLlmScript {
  /** Keyed by `opts.op`. Missing keys throw `not mocked`. */
  complete?: Record<string, string | ((input: unknown) => string | Promise<string>)>;
  completeJson?: Record<
    string,
    unknown | ((input: unknown) => unknown | Promise<unknown>)
  >;
  /** Override the served-by identifier. */
  servedBy?: LlmProviderName | "host_fallback";
  /** Override the reported model. */
  model?: string;
}

export function fakeLlm(script: FakeLlmScript = {}): LlmClient {
  const servedBy: LlmProviderName | "host_fallback" = script.servedBy ?? "openai_compatible";
  const model = script.model ?? "fake-model";
  let requests = 0;

  return {
    provider: "openai_compatible",
    model,
    canStream: false,
    async complete(input, opts): Promise<LlmCompletion> {
      requests++;
      const op = opts?.op ?? "default";
      const entry = (script.complete ?? {})[op];
      if (entry === undefined) {
        throw new Error(`fakeLlm: no complete mock for op="${op}"`);
      }
      const text = typeof entry === "function" ? await entry(input) : entry;
      return {
        text,
        provider: "openai_compatible",
        model,
        servedBy,
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        durationMs: 1,
      };
    },
    async completeJson<T>(input: unknown, opts: unknown): Promise<LlmJsonCompletion<T>> {
      requests++;
      const o = opts as { op?: string; validate?: (v: unknown) => void } | undefined;
      const op = o?.op ?? "default";
      const entry = (script.completeJson ?? {})[op];
      if (entry === undefined) {
        throw new Error(`fakeLlm: no completeJson mock for op="${op}"`);
      }
      const value = (typeof entry === "function"
        ? await (entry as (x: unknown) => unknown)(input)
        : entry) as T;
      if (o?.validate) o.validate(value);
      return {
        value,
        raw: JSON.stringify(value),
        provider: "openai_compatible",
        model,
        finishReason: "stop",
        servedBy,
        durationMs: 1,
      };
    },
    async *stream(): AsyncGenerator<LlmStreamChunk> {
      /* not used in capture tests */
    },
    stats(): LlmClientStats {
      return {
        requests,
        hostFallbacks: 0,
        failures: 0,
        retries: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        lastOkAt: null,
        lastError: null,
      };
    },
    resetStats(): void {
      requests = 0;
    },
    async close(): Promise<void> {
      /* noop */
    },
  };
}

export function throwingLlm(err: Error): LlmClient {
  const base = fakeLlm();
  return {
    ...base,
    async complete(): Promise<LlmCompletion> {
      throw err;
    },
    async completeJson<T>(): Promise<LlmJsonCompletion<T>> {
      throw err;
    },
  };
}
