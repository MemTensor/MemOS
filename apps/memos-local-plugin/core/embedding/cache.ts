/**
 * In-memory LRU cache for embedding vectors.
 *
 * Keys are `sha256(provider|model|role|text)` → 64-char hex.
 * Values are `Float32Array` references (shared, immutable by convention).
 *
 * We deliberately don't persist this to disk: re-embedding on restart is
 * cheap for local models and OK for cloud ones. Keeping it in-memory avoids
 * one more place where secret-ish text could leak to disk.
 */

import { createHash } from "node:crypto";

import { rootLogger } from "../logger/index.js";
import type { EmbeddingVector } from "../types.js";
import type { EmbedRole, EmbeddingProviderName } from "./types.js";

const log = rootLogger.child({ channel: "embedding.cache" });

export interface EmbedCacheStats {
  size: number;
  maxItems: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface EmbedCacheKey {
  provider: EmbeddingProviderName;
  model: string;
  role: EmbedRole;
  text: string;
}

export function makeCacheKey(k: EmbedCacheKey): string {
  const h = createHash("sha256");
  h.update(k.provider);
  h.update("|");
  h.update(k.model);
  h.update("|");
  h.update(k.role);
  h.update("|");
  h.update(k.text);
  return h.digest("hex");
}

export interface EmbedCache {
  get(key: string): EmbeddingVector | undefined;
  set(key: string, vec: EmbeddingVector): void;
  has(key: string): boolean;
  clear(): void;
  stats(): EmbedCacheStats;
}

/**
 * Simple LRU backed by `Map` (insertion-ordered) + promote-on-hit.
 */
export class LruEmbedCache implements EmbedCache {
  private readonly map = new Map<string, EmbeddingVector>();
  private readonly maxItems: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(maxItems: number) {
    if (!Number.isFinite(maxItems) || maxItems < 0) {
      throw new Error(`[embedding.cache] invalid maxItems: ${maxItems}`);
    }
    this.maxItems = Math.floor(maxItems);
  }

  get(key: string): EmbeddingVector | undefined {
    const v = this.map.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    // Promote: delete + re-set moves the entry to the "most recent" slot.
    this.map.delete(key);
    this.map.set(key, v);
    this.hits++;
    return v;
  }

  set(key: string, vec: EmbeddingVector): void {
    if (this.maxItems === 0) return;
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, vec);
    while (this.map.size > this.maxItems) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.evictions++;
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  clear(): void {
    const hadSize = this.map.size;
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    if (hadSize > 0) log.debug("cleared", { hadSize });
  }

  stats(): EmbedCacheStats {
    return {
      size: this.map.size,
      maxItems: this.maxItems,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}

/**
 * No-op cache; used when `cache.enabled: false` to keep call sites uniform.
 */
export class NullEmbedCache implements EmbedCache {
  get(_key: string): EmbeddingVector | undefined {
    return undefined;
  }
  set(_key: string, _vec: EmbeddingVector): void {
    /* no-op */
  }
  has(_key: string): boolean {
    return false;
  }
  clear(): void {}
  stats(): EmbedCacheStats {
    return { size: 0, maxItems: 0, hits: 0, misses: 0, evictions: 0 };
  }
}
