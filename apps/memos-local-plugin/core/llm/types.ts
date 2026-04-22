/**
 * LLM layer public contracts.
 *
 * All call sites inside `core/` must go through the `LlmClient` facade.
 * Providers stay internal to `core/llm/`.
 */

// ─── Providers & config ──────────────────────────────────────────────────────

export type LlmProviderName =
  | "local_only"
  | "openai_compatible"
  | "anthropic"
  | "gemini"
  | "bedrock"
  | "host";

/**
 * Resolved LLM config, post-defaults. Subset of `ResolvedConfig.llm` so
 * the client is unit-testable without the whole config object.
 */
export interface LlmConfig {
  provider: LlmProviderName;
  endpoint?: string;
  model: string;
  temperature: number;
  fallbackToHost: boolean;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  /** Optional per-call default. Default: 1024. */
  maxTokens?: number;
  /** Extra HTTP headers for outgoing requests. */
  headers?: Record<string, string>;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

// ─── Call options ────────────────────────────────────────────────────────────

export interface LlmCallOptions {
  /** Which logical call site is this? Used for log tagging (e.g. "reflection.score"). */
  op?: string;
  /** Override per-call temperature. */
  temperature?: number;
  /** Override per-call maxTokens. */
  maxTokens?: number;
  /** Per-call timeout. */
  timeoutMs?: number;
  /** AbortSignal honored across HTTP + host-bridge calls. */
  signal?: AbortSignal;
  /**
   * When set, the client will try to coerce the provider into returning JSON
   * (via native JSON mode when available, or by injecting a schema hint into
   * the system prompt otherwise). The returned string is still raw text —
   * use `completeJson` for parsed output.
   */
  jsonMode?: boolean;
  /** Extra stop sequences (providers that support it). */
  stop?: string[];
}

// ─── Results ─────────────────────────────────────────────────────────────────

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** USD estimate, best-effort and usually undefined. */
  costUsd?: number;
}

export interface LlmCompletion {
  text: string;
  provider: LlmProviderName;
  model: string;
  finishReason?: "stop" | "length" | "error" | "other";
  usage?: LlmUsage;
  /** Which source served this call. Lets logs distinguish fallback wins. */
  servedBy: LlmProviderName | "host_fallback";
  /** Time spent in the underlying call, in ms. */
  durationMs: number;
}

/**
 * Parsed JSON completion. `raw` always holds the original text in case the
 * caller wants to re-parse or log a malformed response.
 */
export interface LlmJsonCompletion<T> extends Omit<LlmCompletion, "text"> {
  value: T;
  raw: string;
}

// ─── Streaming ───────────────────────────────────────────────────────────────

/** A single streamed chunk. */
export interface LlmStreamChunk {
  /** Incremental text delta (never the full text so far). */
  delta: string;
  /** True when the provider indicates end-of-stream for this message. */
  done: boolean;
  /** Last-chunk metadata; only set when `done === true` on most providers. */
  finishReason?: LlmCompletion["finishReason"];
  usage?: LlmUsage;
}

// ─── Provider contract ───────────────────────────────────────────────────────

export interface LlmProviderCtx {
  config: LlmConfig;
  log: LlmProviderLogger;
  /** Call abort signal; providers must honor it. */
  signal?: AbortSignal;
}

export interface LlmProviderLogger {
  trace(msg: string, detail?: Record<string, unknown>): void;
  debug(msg: string, detail?: Record<string, unknown>): void;
  info(msg: string, detail?: Record<string, unknown>): void;
  warn(msg: string, detail?: Record<string, unknown>): void;
  error(msg: string, detail?: Record<string, unknown>): void;
}

export interface LlmProvider {
  readonly name: LlmProviderName;

  /** Synchronous complete. Every provider must implement this. */
  complete(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
  ): Promise<ProviderCompletion>;

  /**
   * Optional streaming path. If absent, the facade falls back to calling
   * `complete` and emitting the whole text as one chunk.
   */
  stream?(
    messages: LlmMessage[],
    opts: ProviderCallInput,
    ctx: LlmProviderCtx,
  ): AsyncIterable<LlmStreamChunk>;

  close?(): Promise<void>;
}

/** What the facade hands to providers — cooked per-call options. */
export interface ProviderCallInput {
  temperature: number;
  maxTokens: number;
  jsonMode: boolean;
  stop?: string[];
}

/** What providers return — pre-facade post-processing. */
export interface ProviderCompletion {
  text: string;
  finishReason?: LlmCompletion["finishReason"];
  usage?: LlmUsage;
  /** Provider-observed duration (HTTP call only). */
  durationMs: number;
}

// ─── LlmClient facade ────────────────────────────────────────────────────────

export interface LastCallStatus {
  /** Most recent successful call (epoch ms), or `null` if none yet. */
  lastOkAt: number | null;
  /**
   * Most recent failed call. `null` if the client has either never been
   * called or the last call (or a later one) succeeded. Viewer
   * overview uses this to render a red dot + error tooltip.
   */
  lastError: { at: number; message: string } | null;
}

export interface LlmClientStats extends LastCallStatus {
  requests: number;
  hostFallbacks: number;
  failures: number;
  retries: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export interface LlmClient {
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly canStream: boolean;

  /** Plain text completion. Concatenates system + user messages as needed. */
  complete(
    messages: LlmMessage[] | string,
    opts?: LlmCallOptions,
  ): Promise<LlmCompletion>;

  /**
   * JSON completion. Parses + validates with a TypeBox-compatible schema hint.
   * Throws `LLM_OUTPUT_MALFORMED` on unparseable output after retries.
   */
  completeJson<T>(
    messages: LlmMessage[] | string,
    opts?: LlmCompleteJsonOptions<T>,
  ): Promise<LlmJsonCompletion<T>>;

  /** Streaming text. Falls back to one-chunk emit if the provider lacks stream. */
  stream(
    messages: LlmMessage[] | string,
    opts?: LlmCallOptions,
  ): AsyncIterable<LlmStreamChunk>;

  stats(): LlmClientStats;
  resetStats(): void;
  close(): Promise<void>;
}

export interface LlmCompleteJsonOptions<T> extends LlmCallOptions {
  /**
   * Short human-friendly description of the desired JSON shape. Inserted as
   * a system prompt when no native JSON mode is available.
   */
  schemaHint?: string;
  /** Additional validation after parsing (throws on invalid). */
  validate?: (v: unknown) => asserts v is T;
  /** Custom parse — defaults to `JSON.parse` after fence stripping. */
  parse?: (raw: string) => T;
  /** Extra retries specifically for JSON-malformed outputs. Default: 1. */
  malformedRetries?: number;
}
