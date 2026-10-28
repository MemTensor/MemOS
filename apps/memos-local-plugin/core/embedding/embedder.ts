/**
 * The `Embedder` facade. Only module outside `core/embedding/` should care
 * about providers existing at all.
 *
 * Responsibilities:
 *   - Pick the right provider from config.
 *   - Cache by (provider|model|role|text) sha256 hex.
 *   - Batch by `batchSize`, collapse duplicates, preserve input order.
 *   - L2-normalize + dim-enforce (see `normalize.ts`).
 *   - Track stats usable by `stats()` and by `embedding.cache` logs.
 *
 * We intentionally do NOT auto-fallback to `local` when a cloud provider
 * fails — the caller can implement that higher up if it wants to. Keeping
 * this layer strict makes failure modes easy to reason about in tests.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import { rootLogger } from "../logger/index.js";
import type { Logger } from "../logger/types.js";
import type { EmbeddingVector } from "../types.js";
import { extractRetryDiagnostics } from "../util/retry-after.js";
import {
  LruEmbedCache,
  NullEmbedCache,
  makeCacheKey,
  type EmbedCache,
} from "./cache.js";
import { l2Normalize, postProcess } from "./normalize.js";
import { CohereEmbeddingProvider } from "./providers/cohere.js";
import { GeminiEmbeddingProvider } from "./providers/gemini.js";
import { LocalEmbeddingProvider } from "./providers/local.js";
import { MistralEmbeddingProvider } from "./providers/mistral.js";
import { OpenAiEmbeddingProvider } from "./providers/openai.js";
import { VoyageEmbeddingProvider } from "./providers/voyage.js";
import type {
  EmbedCallOptions,
  EmbedInput,
  EmbedRole,
  EmbedStats,
  Embedder,
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingProviderName,
  EmbeddingSettledResult,
  ProviderCallCtx,
  ProviderLogger,
} from "./types.js";

/**
 * Factory. Allows DI of a fake provider for tests — see
 * `createEmbedderWithProvider`.
 */
export function createEmbedder(config: EmbeddingConfig): Embedder {
  const provider = makeProviderFor(config.provider);
  return createEmbedderWithProvider(config, provider);
}

export function createEmbedderWithProvider(
  config: EmbeddingConfig,
  provider: EmbeddingProvider,
): Embedder {
  const cache: EmbedCache = config.cache.enabled
    ? new LruEmbedCache(config.cache.maxItems)
    : new NullEmbedCache();

  const logger = rootLogger.child({ channel: "embedding" });
  const providerLog = rootLogger.child({ channel: `embedding.${provider.name}` });
  const providerCtxLog: ProviderLogger = adaptLogger(providerLog);
  const cacheLog = rootLogger.child({ channel: "embedding.cache" });

  let requests = 0;
  let hits = 0;
  let misses = 0;
  let roundTrips = 0;
  let failures = 0;
  let lastOkAt: number | null = null;
  let lastError: { at: number; message: string } | null = null;
  let actualDimensions = config.dimensions;

  function toInput(i: string | EmbedInput): Required<EmbedInput> {
    if (typeof i === "string") return { text: i, role: "document" };
    return { text: i.text, role: i.role ?? "document" };
  }

  function notifyStatus(detail: {
    status: "ok" | "error";
    provider: string;
    model: string;
    message?: string;
    code?: string;
    at?: number;
    durationMs?: number;
    retryAfterMs?: number;
    retryAt?: number;
    retryDecision?: "wait" | "defer" | "stop";
    retryReason?: string;
  }): void {
    if (!config.onStatus) return;
    try {
      config.onStatus({ kind: "embedding", ...detail });
    } catch {
      /* status sink errors are non-fatal */
    }
  }

  async function embedOne(
    input: string | EmbedInput,
    options?: EmbedCallOptions,
  ): Promise<EmbeddingVector> {
    const result = (await embedManySettled([input], options))[0]!;
    if (!result.ok) throw result.error;
    return result.vector;
  }

  async function embedMany(
    inputs: Array<string | EmbedInput>,
    options?: EmbedCallOptions,
  ): Promise<EmbeddingVector[]> {
    const settled = await embedManySettled(inputs, options);
    const failed = settled.find((result) => !result.ok);
    if (failed && !failed.ok) throw failed.error;
    return settled.map((result) => {
      if (!result.ok) throw result.error;
      return result.vector;
    });
  }

  async function embedManySettled(
    inputs: Array<string | EmbedInput>,
    options?: EmbedCallOptions,
  ): Promise<EmbeddingSettledResult[]> {
    requests += inputs.length;
    if (inputs.length === 0) return [];

    const normalized = inputs.map(toInput);
    const results = new Array<EmbeddingSettledResult | null>(normalized.length).fill(null);
    const dedupEnabled = config.cache.enabled;
    const keys = normalized.map((inp, i) => {
      const base = makeCacheKey({
        provider: provider.name,
        model: config.model,
        role: inp.role,
        text: inp.text,
      });
      // When the cache is off, give every input its own unique key so we
      // don't collapse duplicates either. That preserves the "turn the
      // cache off for benchmarking" use case.
      return dedupEnabled ? base : `${base}#${i}`;
    });

    // Cache lookup. `hits` counts both LRU hits and in-request dedup hits —
    // any input after the first copy is treated as a hit from the caller's
    // perspective (we don't spend a provider round trip on it).
    const missByKey = new Map<string, { role: EmbedRole; text: string; indices: number[] }>();
    for (let i = 0; i < normalized.length; i++) {
      const key = keys[i]!;
      const cached = cache.get(key);
      if (cached !== undefined) {
        results[i] = { ok: true, vector: cached };
        hits++;
        continue;
      }
      const inp = normalized[i]!;
      const group = missByKey.get(key);
      if (group) {
        // Duplicate within this request — we only "miss" the first
        // occurrence; every subsequent one reuses the same round-trip result.
        group.indices.push(i);
        hits++;
        continue;
      }
      misses++;
      missByKey.set(key, { role: inp.role, text: inp.text, indices: [i] });
    }

    if (missByKey.size === 0) {
      cacheLog.trace("all-hit", { n: inputs.length });
      return results as EmbeddingSettledResult[];
    }

    const missEntries = Array.from(missByKey.entries());
    const batchSize = Math.max(1, config.batchSize ?? 32);
    type LogicalWork = {
      key: string;
      role: EmbedRole;
      indices: number[];
      chunks: string[];
      chunkVectors: Array<EmbeddingVector | null>;
      error: MemosError | null;
    };
    type PhysicalWork = {
      logical: LogicalWork;
      chunkIndex: number;
      text: string;
    };

    const logicalWorks: LogicalWork[] = missEntries.map(([key, entry]) => {
      const chunks = splitEmbeddingInput(entry.text, config.maxInputTokens ?? 1_024);
      if (chunks.length > 1) {
        logger.warn("input.chunked", {
          provider: provider.name,
          model: config.model,
          estimatedTokens: estimateEmbeddingTokens(entry.text),
          maxInputTokens: config.maxInputTokens,
          chunks: chunks.length,
        });
      }
      return {
        key,
        role: entry.role,
        indices: entry.indices,
        chunks,
        chunkVectors: new Array<EmbeddingVector | null>(chunks.length).fill(null),
        error: null,
      };
    });

    // Preserve role grouping — provider semantics (e.g. cohere query vs doc)
    // differ per role so we batch per (role) within each round trip.
    const byRole = new Map<EmbedRole, PhysicalWork[]>();
    for (const logical of logicalWorks) {
      const list = byRole.get(logical.role) ?? [];
      for (let chunkIndex = 0; chunkIndex < logical.chunks.length; chunkIndex++) {
        list.push({
          logical,
          chunkIndex,
          text: logical.chunks[chunkIndex]!,
        });
      }
      byRole.set(logical.role, list);
    }

    for (const [role, list] of byRole.entries()) {
      for (let start = 0; start < list.length; start += batchSize) {
        const slice = list.slice(start, start + batchSize);
        const physicalResults = await embedPhysicalBatch(slice, role, options);
        for (let j = 0; j < slice.length; j++) {
          const entry = slice[j]!;
          const result = physicalResults[j]!;
          if (result.ok) entry.logical.chunkVectors[entry.chunkIndex] = result.vector;
          else entry.logical.error ??= result.error;
        }
      }
    }

    for (const logical of logicalWorks) {
      const result: EmbeddingSettledResult = logical.error
        ? { ok: false, error: logical.error }
        : {
            ok: true,
            vector: poolChunkVectors(logical.chunks, logical.chunkVectors, config.normalize ?? true),
          };
      if (result.ok) cache.set(logical.key, result.vector);
      for (const idx of logical.indices) results[idx] = result;
    }

    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) {
        throw new MemosError(
          ERROR_CODES.EMBEDDING_UNAVAILABLE,
          `[embedding] internal: missing vector at index ${i}`,
          { provider: provider.name },
        );
      }
    }
    return results as EmbeddingSettledResult[];
  }

  async function embedPhysicalBatch(
    entries: Array<{ text: string }>,
    role: EmbedRole,
    options?: EmbedCallOptions,
  ): Promise<EmbeddingSettledResult[]> {
    const texts = entries.map((entry) => entry.text);
    roundTrips++;
    const startedAt = Date.now();
    try {
      const ctx: ProviderCallCtx = {
        config,
        log: providerCtxLog,
        signal: options?.signal,
        deadlineAt: options?.deadlineAt,
      };
      const raw = await provider.embed(texts, role, ctx);
      if (raw.length !== texts.length) {
        throw new MemosError(
          ERROR_CODES.EMBEDDING_UNAVAILABLE,
          `${provider.name} returned ${raw.length} vectors for ${texts.length} inputs`,
          { provider: provider.name, reason: "response_count_mismatch" },
        );
      }
      const processed = postProcess(raw, {
        dimensions: actualDimensions,
        provider: provider.name,
        model: config.model,
        normalize: config.normalize ?? true,
      });
      if (actualDimensions <= 0 && processed[0]) {
        actualDimensions = processed[0].length;
        logger.info("dimensions.inferred", {
          provider: provider.name,
          model: config.model,
          dimensions: actualDimensions,
        });
      }
      // Record success but DO NOT clear `lastError` — consumers compare
      // timestamps to determine whether the latest provider event recovered.
      lastOkAt = Date.now();
      notifyStatus({
        status: "ok",
        provider: provider.name,
        model: config.model,
        at: lastOkAt,
        durationMs: lastOkAt - startedAt,
      });
      return processed.map((vector) => ({ ok: true, vector }));
    } catch (err) {
      failures++;
      const wrapped = asEmbeddingError(err, provider.name);
      if (entries.length > 1 && shouldSplitProviderBatch(wrapped)) {
        const mid = entries.length >> 1;
        logger.warn("provider.batch_split", {
          provider: provider.name,
          model: config.model,
          role,
          count: entries.length,
          status: providerStatus(wrapped),
        });
        const left = await embedPhysicalBatch(entries.slice(0, mid), role, options);
        const right = await embedPhysicalBatch(entries.slice(mid), role, options);
        return [...left, ...right];
      }
      recordTerminalProviderFailure(wrapped, role, texts.length, startedAt);
      return entries.map(() => ({ ok: false, error: wrapped }));
    }
  }

  function recordTerminalProviderFailure(
    err: MemosError,
    role: EmbedRole,
    count: number,
    startedAt: number,
  ): void {
    const errAt = Date.now();
    const errMessage = `${err.code}: ${err.message}`;
    lastError = { at: errAt, message: errMessage };
    logger.warn("provider.failed", {
      provider: provider.name,
      model: config.model,
      role,
      count,
      err: toErrDetail(err),
    });
    if (config.onError) {
      try {
        config.onError({
          kind: "embedding",
          provider: provider.name,
          model: config.model,
          message: errMessage,
          code: err.code,
          at: errAt,
          ...extractRetryDiagnostics(err.details),
        });
      } catch {
        /* sink errors are non-fatal */
      }
    }
    notifyStatus({
      status: "error",
      provider: provider.name,
      model: config.model,
      message: errMessage,
      code: err.code,
      at: errAt,
      durationMs: errAt - startedAt,
      ...extractRetryDiagnostics(err.details),
    });
  }

  const api: Embedder = {
    provider: provider.name,
    model: config.model,
    get dimensions() {
      return actualDimensions;
    },
    embedOne,
    embedMany,
    embedManySettled,
    stats(): EmbedStats {
      return { hits, misses, requests, roundTrips, failures, lastOkAt, lastError };
    },
    resetCache(): void {
      cache.clear();
      hits = 0;
      misses = 0;
      roundTrips = 0;
      failures = 0;
      requests = 0;
      lastOkAt = null;
      lastError = null;
    },
    async close(): Promise<void> {
      try {
        await provider.close?.();
      } finally {
        cache.clear();
      }
    },
  };

  logger.info("init", {
    provider: provider.name,
    model: config.model,
    dimensions: actualDimensions > 0 ? actualDimensions : "auto",
    cacheEnabled: config.cache.enabled,
    batchSize: config.batchSize ?? 32,
    maxInputTokens: config.maxInputTokens ?? 1_024,
  });

  return api;
}

const MAX_CHUNKS_PER_LOGICAL_INPUT = 4;
const INPUT_TOKEN_SAFETY_RATIO = 0.9;

/**
 * Dependency-free token estimate for providers that do not expose a tokenizer.
 * It intentionally leans conservative for CJK, emoji, code, and punctuation;
 * the configured value remains a provider limit rather than a character cap.
 */
export function estimateEmbeddingTokens(text: string): number {
  let estimate = 0;
  for (const char of text) estimate += estimatedTokenWeight(char);
  return Math.ceil(estimate);
}

function estimatedTokenWeight(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint > 0xffff) return 2;
  if (codePoint > 0x7f) return 1;
  if (/\s/.test(char)) return 0.25;
  if (/[A-Za-z0-9]/.test(char)) return 0.5;
  return 1;
}

function splitEmbeddingInput(text: string, configuredLimit: number): string[] {
  if (!Number.isFinite(configuredLimit) || configuredLimit <= 0) return [text];
  const maxTokens = Math.max(1, Math.floor(configuredLimit * INPUT_TOKEN_SAFETY_RATIO));
  if (estimateEmbeddingTokens(text) <= maxTokens) return [text];

  const chunks: string[] = [];
  let current = "";
  let currentTokens = 0;
  for (const char of text) {
    const weight = estimatedTokenWeight(char);
    if (current && currentTokens + weight > maxTokens) {
      chunks.push(current);
      current = "";
      currentTokens = 0;
    }
    current += char;
    currentTokens += weight;
  }
  if (current || chunks.length === 0) chunks.push(current);
  if (chunks.length <= MAX_CHUNKS_PER_LOGICAL_INPUT) return chunks;

  // Bound embedding spend for imported transcripts that may be tens of
  // thousands of characters. Uniform sampling retains head/middle/tail
  // coverage and is deterministic, so the logical cache key stays stable.
  const selected: string[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < MAX_CHUNKS_PER_LOGICAL_INPUT; i++) {
    const index = Math.round((i * (chunks.length - 1)) / (MAX_CHUNKS_PER_LOGICAL_INPUT - 1));
    if (!seen.has(index)) {
      selected.push(chunks[index]!);
      seen.add(index);
    }
  }
  return selected;
}

function poolChunkVectors(
  chunks: string[],
  vectors: Array<EmbeddingVector | null>,
  normalize: boolean,
): EmbeddingVector {
  const first = vectors.find((vector): vector is EmbeddingVector => vector !== null);
  if (!first || vectors.some((vector) => vector === null)) {
    throw new MemosError(
      ERROR_CODES.EMBEDDING_UNAVAILABLE,
      "[embedding] internal: missing chunk vector",
    );
  }
  if (vectors.length === 1) return first;

  const pooled = new Float32Array(first.length);
  let totalWeight = 0;
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i]!;
    const weight = Math.max(1, estimateEmbeddingTokens(chunks[i]!));
    totalWeight += weight;
    for (let j = 0; j < pooled.length; j++) pooled[j]! += vector[j]! * weight;
  }
  for (let j = 0; j < pooled.length; j++) pooled[j]! /= totalWeight;
  return normalize ? l2Normalize(pooled) : pooled;
}

function asEmbeddingError(err: unknown, provider: EmbeddingProviderName): MemosError {
  if (err instanceof MemosError) return err;
  return new MemosError(
    ERROR_CODES.EMBEDDING_UNAVAILABLE,
    `${provider} failed: ${err instanceof Error ? err.message : String(err)}`,
    { provider },
  );
}

function providerStatus(err: MemosError): number | null {
  const status = (err.details as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : null;
}

function shouldSplitProviderBatch(err: MemosError): boolean {
  const status = providerStatus(err);
  return status === 400 || status === 413 || status === 422;
}

// ─── Provider lookup ─────────────────────────────────────────────────────────

export function makeProviderFor(name: EmbeddingProviderName): EmbeddingProvider {
  switch (name) {
    case "local":
      return new LocalEmbeddingProvider();
    case "openai_compatible":
      return new OpenAiEmbeddingProvider();
    case "gemini":
      return new GeminiEmbeddingProvider();
    case "cohere":
      return new CohereEmbeddingProvider();
    case "voyage":
      return new VoyageEmbeddingProvider();
    case "mistral":
      return new MistralEmbeddingProvider();
    default:
      throw new MemosError(
        ERROR_CODES.UNSUPPORTED,
        `Unknown embedding provider: ${String(name)}`,
        { provider: name },
      );
  }
}

// ─── Logger adapter ──────────────────────────────────────────────────────────

function adaptLogger(log: Logger): ProviderLogger {
  return {
    trace: (msg, detail) => log.trace(msg, detail),
    debug: (msg, detail) => log.debug(msg, detail),
    info: (msg, detail) => log.info(msg, detail),
    warn: (msg, detail) => log.warn(msg, detail),
    error: (msg, detail) => log.error(msg, detail),
  };
}

function toErrDetail(err: unknown): Record<string, unknown> {
  if (err instanceof MemosError) return { ...err.toJSON() };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}
