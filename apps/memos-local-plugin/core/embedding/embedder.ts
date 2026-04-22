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
import {
  LruEmbedCache,
  NullEmbedCache,
  makeCacheKey,
  type EmbedCache,
} from "./cache.js";
import { postProcess } from "./normalize.js";
import { CohereEmbeddingProvider } from "./providers/cohere.js";
import { GeminiEmbeddingProvider } from "./providers/gemini.js";
import { LocalEmbeddingProvider } from "./providers/local.js";
import { MistralEmbeddingProvider } from "./providers/mistral.js";
import { OpenAiEmbeddingProvider } from "./providers/openai.js";
import { VoyageEmbeddingProvider } from "./providers/voyage.js";
import type {
  EmbedInput,
  EmbedRole,
  EmbedStats,
  Embedder,
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingProviderName,
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

  function toInput(i: string | EmbedInput): Required<EmbedInput> {
    if (typeof i === "string") return { text: i, role: "document" };
    return { text: i.text, role: i.role ?? "document" };
  }

  async function embedOne(input: string | EmbedInput): Promise<EmbeddingVector> {
    const vecs = await embedMany([input]);
    return vecs[0]!;
  }

  async function embedMany(
    inputs: Array<string | EmbedInput>,
  ): Promise<EmbeddingVector[]> {
    requests += inputs.length;
    if (inputs.length === 0) return [];

    const normalized = inputs.map(toInput);
    const results = new Array<EmbeddingVector | null>(normalized.length).fill(null);
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
        results[i] = cached;
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
      return results as EmbeddingVector[];
    }

    const missEntries = Array.from(missByKey.entries());
    const batchSize = Math.max(1, config.batchSize ?? 32);

    // Preserve role grouping — provider semantics (e.g. cohere query vs doc)
    // differ per role so we batch per (role) within each round trip.
    const byRole = new Map<
      EmbedRole,
      Array<{ key: string; text: string; indices: number[] }>
    >();
    for (const [key, entry] of missEntries) {
      const list = byRole.get(entry.role) ?? [];
      list.push({ key, text: entry.text, indices: entry.indices });
      byRole.set(entry.role, list);
    }

    for (const [role, list] of byRole.entries()) {
      for (let start = 0; start < list.length; start += batchSize) {
        const slice = list.slice(start, start + batchSize);
        const texts = slice.map((s) => s.text);
        roundTrips++;
        let raw: number[][];
        try {
          const ctx: ProviderCallCtx = {
            config,
            log: providerCtxLog,
          };
          raw = await provider.embed(texts, role, ctx);
          lastOkAt = Date.now();
          lastError = null;
        } catch (err) {
          failures++;
          lastError = {
            at: Date.now(),
            message:
              err instanceof MemosError
                ? `${err.code}: ${err.message}`
                : err instanceof Error
                ? err.message
                : String(err),
          };
          logger.warn("provider.failed", {
            provider: provider.name,
            model: config.model,
            role,
            count: texts.length,
            err: toErrDetail(err),
          });
          throw err instanceof MemosError
            ? err
            : new MemosError(
                ERROR_CODES.EMBEDDING_UNAVAILABLE,
                `${provider.name} failed: ${(err as Error).message ?? String(err)}`,
                { provider: provider.name },
              );
        }
        if (raw.length !== texts.length) {
          throw new MemosError(
            ERROR_CODES.EMBEDDING_UNAVAILABLE,
            `${provider.name} returned ${raw.length} vectors for ${texts.length} inputs`,
            { provider: provider.name },
          );
        }
        const normalize = config.normalize ?? true;
        const processed = postProcess(raw, {
          dimensions: config.dimensions,
          provider: provider.name,
          model: config.model,
          normalize,
        });
        for (let j = 0; j < slice.length; j++) {
          const vec = processed[j]!;
          const entry = slice[j]!;
          cache.set(entry.key, vec);
          for (const idx of entry.indices) results[idx] = vec;
        }
      }
    }

    // Final assertion — everything should be filled by now.
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) {
        throw new MemosError(
          ERROR_CODES.EMBEDDING_UNAVAILABLE,
          `[embedding] internal: missing vector at index ${i}`,
          { provider: provider.name },
        );
      }
    }
    return results as EmbeddingVector[];
  }

  const api: Embedder = {
    provider: provider.name,
    model: config.model,
    dimensions: config.dimensions,
    embedOne,
    embedMany,
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
    dimensions: config.dimensions,
    cacheEnabled: config.cache.enabled,
    batchSize: config.batchSize ?? 32,
  });

  return api;
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
