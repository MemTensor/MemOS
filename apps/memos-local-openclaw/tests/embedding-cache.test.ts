import { describe, expect, it } from "vitest";

import { EmbeddingCache } from "../src/embedding/cache";

describe("EmbeddingCache", () => {
  it("returns a cached embedding", async () => {
    const cache = new EmbeddingCache({ maxSize: 2, ttlMs: 1_000 });
    await cache.set("openai:model-a:3", "query", [1, 2, 3]);

    expect(await cache.get("openai:model-a:3", "query")).toEqual([1, 2, 3]);
    expect(await cache.has("openai:model-a:3", "query")).toBe(true);
  });

  it("expires entries after the configured TTL", async () => {
    let now = 100;
    const cache = new EmbeddingCache({ maxSize: 2, ttlMs: 50, now: () => now });
    await cache.set("openai:model-a:3", "query", [1, 2, 3]);

    now = 149;
    expect(await cache.get("openai:model-a:3", "query")).toEqual([1, 2, 3]);
    now = 150;
    expect(await cache.get("openai:model-a:3", "query")).toBeNull();
  });

  it("evicts the least recently used entry", async () => {
    const cache = new EmbeddingCache({ maxSize: 2, ttlMs: 1_000 });
    const signature = "openai:model-a:1";
    await cache.set(signature, "first", [1]);
    await cache.set(signature, "second", [2]);
    await cache.get(signature, "first");
    await cache.set(signature, "third", [3]);

    expect(await cache.get(signature, "first")).toEqual([1]);
    expect(await cache.get(signature, "second")).toBeNull();
    expect(await cache.get(signature, "third")).toEqual([3]);
  });

  it("keys identical text by provider, model, and dimensions", async () => {
    const cache = new EmbeddingCache({ maxSize: 4, ttlMs: 1_000 });
    await cache.set("openai:model-a:3", "same query", [1, 0, 0]);
    await cache.set("openai:model-b:3", "same query", [0, 1, 0]);

    expect(await cache.get("openai:model-a:3", "same query")).toEqual([1, 0, 0]);
    expect(await cache.get("openai:model-b:3", "same query")).toEqual([0, 1, 0]);
    expect(await cache.get("openai:model-a:4", "same query")).toBeNull();
  });
});
