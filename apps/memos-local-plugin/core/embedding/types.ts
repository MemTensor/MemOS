/**
 * Public surface for the embedding layer.
 *
 * All call sites inside `core/` should use the `Embedder` facade. Providers
 * are never imported directly outside of `core/embedding/`.
 */

import type { EmbeddingVector } from "../types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export type EmbeddingProviderName =
  | "local"
  | "openai_compatible"
  | "gemini"
  | "cohere"
  | "voyage"
  | "mistral";

/**
 * Resolved embedding config, post-defaults. Subset of the full `ResolvedConfig`
 * so the embedder can be unit-tested without a full config object.
 */
export interface EmbeddingConfig {
  provider: EmbeddingProviderName;
  endpoint?: string;
  model: string;
  dimensions: number;
  apiKey?: string;
  cache: {
    enabled: boolean;
    maxItems: number;
  };
  /** Timeout per HTTP call. Default: 30_000 ms. */
  timeoutMs?: number;
  /** Retries on transient errors (5xx, 429, network). Default: 2. */
  maxRetries?: number;
  /** Max texts per HTTP round trip. Default: 32. */
  batchSize?: number;
  /** Extra headers to tack on outgoing HTTP. */
  headers?: Record<string, string>;
  /** If true, all output vectors are L2-normalized. Default: true. */
  normalize?: boolean;
  /**
   * Optional sink invoked once per terminal provider failure. Lets the
   * bootstrap layer write a `system_error` row to `api_logs` so the
   * Logs viewer can surface infrastructure failures alongside tool
   * activity. Never throws; any exception inside the sink is swallowed.
   */
  onError?: (detail: EmbeddingErrorDetail) => void;
  /**
   * Optional durable status sink invoked on successful and failed
   * provider calls. Unlike `onError` (human-facing log only), this
   * is the machine-readable source used by the Overview model cards.
   */
  onStatus?: (detail: EmbeddingStatusDetail) => void;
}

export interface EmbeddingErrorDetail {
  kind: "embedding";
  provider: EmbeddingProviderName | string;
  model: string;
  message: string;
  /** Stable `MemosError` code when the underlying error carries one. */
  code?: string;
  /** Epoch ms at which the failure occurred (defaults to Date.now()). */
  at?: number;
}

export interface EmbeddingStatusDetail {
  kind: "embedding";
  status: "ok" | "error";
  provider: EmbeddingProviderName | string;
  model: string;
  message?: string;
  code?: string;
  at?: number;
}

// ─── Roles ───────────────────────────────────────────────────────────────────

/**
 * Cohere (and a handful of others) distinguishes "document" and "query"
 * inputs. Most providers ignore it. Caller hints via `role` and we translate.
 */
export type EmbedRole = "document" | "query";

export interface EmbedInput {
  text: string;
  role?: EmbedRole;   // default: "document"
}

// ─── Provider contract ───────────────────────────────────────────────────────

/**
 * Every provider implements the same shape. The embedder handles:
 *   - batching (chunking into `batchSize` slices)
 *   - caching (by sha256 of provider|model|role|text)
 *   - retries / timeouts (via `fetcher.ts`)
 *   - dim validation + L2-normalize
 * Providers focus on the HTTP / native call.
 */
export interface EmbeddingProvider {
  readonly name: EmbeddingProviderName;

  /** Providers should return float arrays in config-declared dimensionality. */
  embed(
    texts: string[],
    role: EmbedRole,
    ctx: ProviderCallCtx,
  ): Promise<number[][]>;

  /** Called at shutdown. Default: no-op. */
  close?(): Promise<void>;
}

export interface ProviderCallCtx {
  config: EmbeddingConfig;
  /** Scoped child logger already tagged with the provider name. */
  log: ProviderLogger;
  /** AbortSignal honored across HTTP + native calls. */
  signal?: AbortSignal;
}

export interface ProviderLogger {
  trace(msg: string, detail?: Record<string, unknown>): void;
  debug(msg: string, detail?: Record<string, unknown>): void;
  info(msg: string, detail?: Record<string, unknown>): void;
  warn(msg: string, detail?: Record<string, unknown>): void;
  error(msg: string, detail?: Record<string, unknown>): void;
}

// ─── Embedder facade ─────────────────────────────────────────────────────────

export interface EmbedStats {
  hits: number;
  misses: number;
  requests: number;
  roundTrips: number;
  /** Provider call failures that were retried or fell through. */
  failures: number;
  /** Most recent successful round-trip to the provider (epoch ms). */
  lastOkAt: number | null;
  /**
   * Most recent failure. `null` until the embedder has thrown at least
   * once. Once set, it is **not** cleared by a subsequent success —
   * the viewer compares `lastError.at` against `lastOkAt` to decide
   * whether the most recent event was good (green) or bad (red), so
   * users never see a green dot while a real provider error is still
   * sitting in the system_error log.
   */
  lastError: { at: number; message: string } | null;
}

export interface Embedder {
  readonly dimensions: number;
  readonly provider: EmbeddingProviderName;
  /** Model identifier as configured by the operator (e.g. "bge-m3"). */
  readonly model: string;

  embedOne(input: string | EmbedInput): Promise<EmbeddingVector>;

  /**
   * Batch-embed many texts. Results keep input order. Duplicates are deduped
   * internally so a text repeated N times causes 1 cache miss max.
   */
  embedMany(inputs: Array<string | EmbedInput>): Promise<EmbeddingVector[]>;

  stats(): EmbedStats;

  resetCache(): void;

  close(): Promise<void>;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export interface ProviderHttpFailure {
  status: number;
  body?: string;
  url: string;
  provider: EmbeddingProviderName;
}
