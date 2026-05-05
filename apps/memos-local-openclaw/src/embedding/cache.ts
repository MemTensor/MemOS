import type { Logger } from "../types";

interface CacheEntry {
  vector: number[];
  timestamp: number;
}

interface CacheOptions {
  maxSize: number;
  ttlMs: number;
}

/**
 * LRU Cache for embedding vectors
 * 
 * - maxSize: maximum number of cached entries
 * - ttlMs: time-to-live in milliseconds
 * 
 * Uses SHA-256 hash of query text as key for fast lookup
 */
export class EmbeddingCache {
  private cache: Map<string, CacheEntry>;
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private accessOrder: string[];

  constructor(options: CacheOptions, private log?: Logger) {
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
    this.cache = new Map();
    this.accessOrder = [];
  }

  /**
   * Generate SHA-256 hash of text
   */
  private async hashText(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text.trim().toLowerCase());
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Get cached embedding if available and not expired
   */
  async get(text: string): Promise<number[] | null> {
    const key = await this.hashText(text);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check TTL
    const now = Date.now();
    if (now - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      this.log?.debug(`[EmbeddingCache] Entry expired for key: ${key.slice(0, 16)}...`);
      return null;
    }

    // Update access order for LRU
    this.updateAccessOrder(key);
    this.log?.debug(`[EmbeddingCache] Cache hit for key: ${key.slice(0, 16)}...`);
    return entry.vector;
  }

  /**
   * Store embedding in cache
   */
  async set(text: string, vector: number[]): Promise<void> {
    const key = await this.hashText(text);

    // If at capacity and adding new entry, evict oldest
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, {
      vector,
      timestamp: Date.now(),
    });
    this.updateAccessOrder(key);
    this.log?.debug(`[EmbeddingCache] Cached embedding for key: ${key.slice(0, 16)}...`);
  }

  /**
   * Check if text is cached and valid
   */
  async has(text: string): Promise<boolean> {
    const key = await this.hashText(text);
    const entry = this.cache.get(key);
    
    if (!entry) return false;
    
    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      return false;
    }
    
    return true;
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; maxSize: number; ttlMs: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
    };
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.log?.debug("[EmbeddingCache] Cache cleared");
  }

  private updateAccessOrder(key: string): void {
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;
    const oldestKey = this.accessOrder.shift();
    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.log?.debug(`[EmbeddingCache] Evicted LRU entry: ${oldestKey.slice(0, 16)}...`);
    }
  }
}

// Default cache configuration
export const DEFAULT_CACHE_OPTIONS: CacheOptions = {
  maxSize: 1000,
  ttlMs: 60 * 60 * 1000, // 1 hour
};

// Global cache instance (singleton pattern)
let globalCache: EmbeddingCache | null = null;

export function getGlobalCache(log?: Logger): EmbeddingCache {
  if (!globalCache) {
    globalCache = new EmbeddingCache(DEFAULT_CACHE_OPTIONS, log);
  }
  return globalCache;
}

export function resetGlobalCache(): void {
  globalCache = null;
}
