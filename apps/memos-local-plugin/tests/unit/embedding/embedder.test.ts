import { beforeAll, describe, expect, it } from "vitest";

import { MemosError } from "../../../agent-contract/errors.js";
import { createEmbedderWithProvider } from "../../../core/embedding/embedder.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type {
  EmbedRole,
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingProviderName,
  ProviderCallCtx,
} from "../../../core/embedding/types.js";

/** Deterministic fake: embed("abc") = [len, first-char-code, role-flag]. */
class FakeProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "openai_compatible";
  calls: Array<{ texts: string[]; role: EmbedRole }> = [];

  constructor(public roundTripsAllowed = Number.POSITIVE_INFINITY) {}

  async embed(texts: string[], role: EmbedRole): Promise<number[][]> {
    if (this.calls.length >= this.roundTripsAllowed) {
      throw new Error("fake: too many round trips");
    }
    this.calls.push({ texts: [...texts], role });
    return texts.map((t) => [t.length, t.length > 0 ? t.charCodeAt(0) : 0, role === "query" ? 1 : 0]);
  }
}

class BrokenProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "gemini";
  async embed(_texts: string[], _role: EmbedRole): Promise<number[][]> {
    throw new MemosError("embedding_unavailable", "boom", { provider: "gemini" });
  }
}

class WrongCountProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "gemini";
  async embed(texts: string[]): Promise<number[][]> {
    // Return 1 row regardless of request length → facade must reject it.
    return [[1, 0, 0]].slice(0, 1 * Math.min(1, texts.length));
  }
}

class SmallDimProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "cohere";
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1]);
  }
}

function cfg(partial: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    provider: "openai_compatible",
    model: "m",
    dimensions: 3,
    endpoint: "",
    apiKey: "K",
    cache: { enabled: true, maxItems: 100 },
    normalize: false,
    batchSize: 3,
    ...partial,
  } as EmbeddingConfig;
}

describe("embedder facade", () => {
  beforeAll(() => initTestLogger());

  it("embedOne returns a single vector with configured dimensions", async () => {
    const p = new FakeProvider();
    const e = createEmbedderWithProvider(cfg(), p);
    const v = await e.embedOne("abc");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(3);
    expect(Array.from(v)).toEqual([3, 97, 0]); // a=97
  });

  it("dedups identical inputs into one provider call", async () => {
    const p = new FakeProvider();
    const e = createEmbedderWithProvider(cfg(), p);
    const out = await e.embedMany(["same", "same", "same"]);
    expect(out).toHaveLength(3);
    // Same vector reference is fine — key property is the inputs collapse.
    expect(Array.from(out[0]!)).toEqual([4, 115, 0]);
    expect(Array.from(out[1]!)).toEqual([4, 115, 0]);
    expect(Array.from(out[2]!)).toEqual([4, 115, 0]);
    // Only 1 round trip, 1 text in it.
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.texts).toEqual(["same"]);
    const s = e.stats();
    expect(s.misses).toBe(1);
    expect(s.hits).toBe(2);
    expect(s.requests).toBe(3);
    expect(s.roundTrips).toBe(1);
  });

  it("batches by batchSize, preserves input order", async () => {
    const p = new FakeProvider();
    const e = createEmbedderWithProvider(cfg({ batchSize: 2 }), p);
    const out = await e.embedMany(["a", "bb", "ccc", "dddd"]);
    expect(out).toHaveLength(4);
    expect(Array.from(out[0]!)).toEqual([1, 97, 0]);
    expect(Array.from(out[3]!)).toEqual([4, 100, 0]);
    expect(p.calls.map((c) => c.texts)).toEqual([["a", "bb"], ["ccc", "dddd"]]);
  });

  it("splits by role before batching", async () => {
    const p = new FakeProvider();
    const e = createEmbedderWithProvider(cfg({ batchSize: 10 }), p);
    const out = await e.embedMany([
      { text: "d1", role: "document" },
      { text: "q1", role: "query" },
      { text: "d2", role: "document" },
    ]);
    expect(out).toHaveLength(3);
    // Two round trips (one per role).
    expect(p.calls).toHaveLength(2);
    const roles = p.calls.map((c) => c.role);
    expect(roles).toEqual(expect.arrayContaining(["document", "query"]));
    // The role-flag in the fake's last component proves role was honored.
    const q1 = out.find((_, i) => (out[i]![2] ?? 0) === 1);
    expect(q1).toBeDefined();
  });

  it("cache hits on repeat calls (across embedMany invocations)", async () => {
    const p = new FakeProvider();
    const e = createEmbedderWithProvider(cfg(), p);
    await e.embedMany(["alpha", "beta"]);
    await e.embedMany(["alpha", "gamma"]);
    const s = e.stats();
    expect(s.roundTrips).toBe(2); // ["alpha","beta"] then ["gamma"]
    expect(s.misses).toBe(3); // alpha, beta, gamma
    expect(s.hits).toBe(1);   // alpha reused
    expect(p.calls.flatMap((c) => c.texts)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("resetCache clears both values and stats", async () => {
    const p = new FakeProvider();
    const e = createEmbedderWithProvider(cfg(), p);
    await e.embedMany(["x", "x"]);
    e.resetCache();
    const s = e.stats();
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    expect(s.roundTrips).toBe(0);
  });

  it("cache disabled uses NullEmbedCache (no hits ever)", async () => {
    const p = new FakeProvider();
    const e = createEmbedderWithProvider(cfg({ cache: { enabled: false, maxItems: 0 } }), p);
    await e.embedMany(["a", "a"]);
    expect(e.stats().hits).toBe(0);
    expect(p.calls.flatMap((c) => c.texts)).toEqual(["a", "a"]);
  });

  it("wraps non-MemosError thrown by provider", async () => {
    const broken: EmbeddingProvider = {
      name: "voyage",
      async embed() {
        throw new Error("nope");
      },
    };
    const e = createEmbedderWithProvider(cfg({ provider: "voyage" }), broken);
    await expect(e.embedMany(["x"])).rejects.toBeInstanceOf(MemosError);
  });

  it("re-throws MemosError untouched", async () => {
    const e = createEmbedderWithProvider(cfg({ provider: "gemini" }), new BrokenProvider());
    try {
      await e.embedMany(["x"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe("embedding_unavailable");
    }
  });

  it("rejects when provider returns too few rows", async () => {
    const e = createEmbedderWithProvider(cfg({ provider: "gemini" }), new WrongCountProvider());
    await expect(e.embedMany(["x", "y", "z"])).rejects.toBeInstanceOf(MemosError);
  });

  it("rejects when provider returns fewer dimensions than configured", async () => {
    const e = createEmbedderWithProvider(
      cfg({ provider: "cohere", dimensions: 3 }),
      new SmallDimProvider(),
    );
    await expect(e.embedOne("x")).rejects.toBeInstanceOf(MemosError);
  });

  it("L2-normalizes when normalize=true (default)", async () => {
    // Provider returns [len, code, 0]; for "ab" → [2, 97, 0], normalized.
    const p = new FakeProvider();
    const e = createEmbedderWithProvider(cfg({ normalize: true }), p);
    const v = await e.embedOne("ab");
    const dot = Array.from(v).reduce((s, x) => s + x * x, 0);
    expect(dot).toBeCloseTo(1, 5);
  });

  it("honors custom AbortSignal indirectly through provider ctx", async () => {
    let sawSignal = false;
    const p: EmbeddingProvider = {
      name: "openai_compatible",
      async embed(texts: string[], _role: EmbedRole, ctx: ProviderCallCtx): Promise<number[][]> {
        if (ctx.signal) sawSignal = true; // we don't pass one in facade; should be undefined
        return texts.map(() => [1, 0, 0]);
      },
    };
    const e = createEmbedderWithProvider(cfg(), p);
    await e.embedMany(["x"]);
    expect(sawSignal).toBe(false);
  });

  it("close clears cache and invokes provider.close() once", async () => {
    let closed = 0;
    const p: EmbeddingProvider = {
      name: "openai_compatible",
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(() => [1, 0, 0]);
      },
      async close(): Promise<void> {
        closed++;
      },
    };
    const e = createEmbedderWithProvider(cfg(), p);
    await e.embedOne("x");
    await e.close();
    expect(closed).toBe(1);
    expect(e.stats().hits).toBe(0);
  });
});
