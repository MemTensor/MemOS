import { createHash } from "node:crypto";
import type { Logger } from "../types";

interface CacheEntry {
  vector: number[];
  timestamp: number;
}

export interface CacheOptions {
  maxSize: number;
  ttlMs: number;
  now?: () => number;
}

export class EmbeddingCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(
    private readonly options: CacheOptions,
    private readonly log?: Logger,
  ) {
    this.now = options.now ?? Date.now;
  }

  async get(signature: string, text: string): Promise<number[] | null> {
    const key = this.cacheKey(signature, text);
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (this.now() - entry.timestamp >= this.options.ttlMs) {
      this.cache.delete(key);
      this.log?.debug(`[EmbeddingCache] Entry expired for key: ${key.slice(0, 16)}...`);
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    this.log?.debug(`[EmbeddingCache] Cache hit for key: ${key.slice(0, 16)}...`);
    return [...entry.vector];
  }

  async set(signature: string, text: string, vector: number[]): Promise<void> {
    if (this.options.maxSize <= 0 || this.options.ttlMs <= 0) return;

    const key = this.cacheKey(signature, text);
    this.cache.delete(key);
    while (this.cache.size >= this.options.maxSize) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
      this.log?.debug(`[EmbeddingCache] Evicted LRU entry: ${oldestKey.slice(0, 16)}...`);
    }

    this.cache.set(key, { vector: [...vector], timestamp: this.now() });
    this.log?.debug(`[EmbeddingCache] Cached embedding for key: ${key.slice(0, 16)}...`);
  }

  async has(signature: string, text: string): Promise<boolean> {
    return (await this.get(signature, text)) !== null;
  }

  getStats(): { size: number; maxSize: number; ttlMs: number } {
    return {
      size: this.cache.size,
      maxSize: this.options.maxSize,
      ttlMs: this.options.ttlMs,
    };
  }

  clear(): void {
    this.cache.clear();
    this.log?.debug("[EmbeddingCache] Cache cleared");
  }

  private cacheKey(signature: string, text: string): string {
    return createHash("sha256").update(signature).update("\0").update(text).digest("hex");
  }
}

export const DEFAULT_CACHE_OPTIONS: CacheOptions = {
  maxSize: 1000,
  ttlMs: 60 * 60 * 1000,
};

let globalCache: EmbeddingCache | null = null;

export function getGlobalCache(log?: Logger): EmbeddingCache {
  if (!globalCache) globalCache = new EmbeddingCache(DEFAULT_CACHE_OPTIONS, log);
  return globalCache;
}

export function resetGlobalCache(): void {
  globalCache = null;
}
