import { beforeAll, describe, expect, it } from "vitest";

import { initTestLogger } from "../../../core/logger/index.js";
import {
  LruEmbedCache,
  NullEmbedCache,
  makeCacheKey,
} from "../../../core/embedding/cache.js";

describe("embedding/cache", () => {
  beforeAll(() => initTestLogger());

  it("makeCacheKey is deterministic and role-sensitive", () => {
    const a = makeCacheKey({
      provider: "openai_compatible",
      model: "m",
      role: "document",
      text: "hello",
    });
    const b = makeCacheKey({
      provider: "openai_compatible",
      model: "m",
      role: "document",
      text: "hello",
    });
    const c = makeCacheKey({
      provider: "openai_compatible",
      model: "m",
      role: "query",
      text: "hello",
    });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(64);
  });

  it("LRU get miss counts + set / hit counts", () => {
    const c = new LruEmbedCache(2);
    expect(c.get("k1")).toBeUndefined();
    expect(c.stats().misses).toBe(1);

    c.set("k1", new Float32Array([1, 0]));
    const v = c.get("k1");
    expect(v).toBeDefined();
    expect(c.stats().hits).toBe(1);
    expect(c.stats().size).toBe(1);
  });

  it("LRU evicts the least-recently-used entry", () => {
    const c = new LruEmbedCache(2);
    c.set("a", new Float32Array([1]));
    c.set("b", new Float32Array([2]));
    c.get("a"); // a promoted; b is now LRU
    c.set("c", new Float32Array([3]));
    expect(c.has("b")).toBe(false);
    expect(c.has("a")).toBe(true);
    expect(c.has("c")).toBe(true);
    expect(c.stats().evictions).toBe(1);
  });

  it("LRU clears stats + entries", () => {
    const c = new LruEmbedCache(5);
    c.set("x", new Float32Array([0]));
    c.get("x");
    c.clear();
    expect(c.stats().size).toBe(0);
    expect(c.stats().hits).toBe(0);
    expect(c.get("x")).toBeUndefined();
  });

  it("maxItems=0 disables writes but accepts gets", () => {
    const c = new LruEmbedCache(0);
    c.set("x", new Float32Array([0]));
    expect(c.stats().size).toBe(0);
    expect(c.get("x")).toBeUndefined();
  });

  it("rejects negative or non-finite maxItems", () => {
    expect(() => new LruEmbedCache(-1)).toThrow();
    expect(() => new LruEmbedCache(Number.NaN)).toThrow();
    expect(() => new LruEmbedCache(Infinity)).toThrow();
  });

  it("NullEmbedCache has a no-op surface", () => {
    const n = new NullEmbedCache();
    n.set("a", new Float32Array([1]));
    expect(n.get("a")).toBeUndefined();
    expect(n.has("a")).toBe(false);
    n.clear();
    expect(n.stats()).toEqual({
      size: 0,
      maxItems: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
    });
  });
});
