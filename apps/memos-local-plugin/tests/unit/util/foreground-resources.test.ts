import { describe, expect, it } from "vitest";

import { MemosError } from "../../../agent-contract/errors.js";
import type { Embedder } from "../../../core/embedding/types.js";
import {
  createForegroundResources,
  prioritizeEmbedder,
} from "../../../core/util/foreground-resources.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";

describe("foreground resources", () => {
  it("admits a queued foreground embedding before queued background work", async () => {
    const resources = createForegroundResources({ embeddingConcurrency: 1 });
    const first = await resources.acquireEmbedding("background");
    const order: string[] = [];

    const background = resources.acquireEmbedding("background").then((release) => {
      order.push("background");
      release();
    });
    const foreground = resources.acquireEmbedding("foreground").then((release) => {
      order.push("foreground");
      release();
    });

    first();
    await Promise.all([foreground, background]);

    expect(order).toEqual(["foreground", "background"]);
  });

  it("lets background work progress after a bounded foreground burst", async () => {
    const resources = createForegroundResources({
      embeddingConcurrency: 1,
      maxForegroundBurst: 2,
    });
    const first = await resources.acquireEmbedding("foreground");
    const order: string[] = [];

    const background = resources.acquireEmbedding("background").then((release) => {
      order.push("background");
      release();
    });
    const foreground1 = resources.acquireEmbedding("foreground").then((release) => {
      order.push("foreground-1");
      release();
    });
    const foreground2 = resources.acquireEmbedding("foreground").then((release) => {
      order.push("foreground-2");
      release();
    });

    first();
    await Promise.all([background, foreground1, foreground2]);

    expect(order).toEqual(["foreground-1", "background", "foreground-2"]);
  });

  it("does not start background work while a foreground turn is active", async () => {
    const resources = createForegroundResources();
    const leaveForeground = resources.enterForeground();
    let started = false;

    const waiting = resources.waitForBackground().then(() => {
      started = true;
    });
    await Promise.resolve();
    expect(started).toBe(false);

    leaveForeground();
    await waiting;
    expect(started).toBe(true);
  });

  it("removes an aborted embedding waiter without consuming capacity", async () => {
    const resources = createForegroundResources({ embeddingConcurrency: 1 });
    const first = await resources.acquireEmbedding("background");
    const controller = new AbortController();
    const waiting = resources.acquireEmbedding("foreground", controller.signal);

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    first();

    const release = await resources.acquireEmbedding("background");
    release();
  });

  it("chunks background embedding batches and yields between chunks", async () => {
    const resources = createForegroundResources({ embeddingConcurrency: 1 });
    const base = fakeEmbedder({ dimensions: 4 });
    const batchSizes: number[] = [];
    const inner = {
      ...base,
      async embedMany(...args: Parameters<typeof base.embedMany>) {
        batchSizes.push(args[0].length);
        return base.embedMany(...args);
      },
    };
    const background = prioritizeEmbedder(inner, resources, "background", 2)!;

    await background.embedMany(["a", "b", "c", "d", "e"]);

    expect(batchSizes).toEqual([2, 2, 1]);
  });

  it("preserves settled-result isolation through the priority wrapper", async () => {
    const resources = createForegroundResources({ embeddingConcurrency: 1 });
    const base = fakeEmbedder({ dimensions: 4 });
    const inner = {
      ...base,
      async embedManySettled(inputs: Parameters<typeof base.embedMany>[0]) {
        return inputs.map(() => ({
          ok: true as const,
          vector: new Float32Array([1, 2, 3, 4]),
        }));
      },
    };
    const background = prioritizeEmbedder(inner, resources, "background", 2)!;

    const settled = await background.embedManySettled?.(["a", "b", "c"]);

    expect(settled).toHaveLength(3);
    expect(settled?.every((result) => result.ok)).toBe(true);
  });

  it("settles legacy embedMany failures instead of rejecting the wrapper call", async () => {
    const resources = createForegroundResources({ embeddingConcurrency: 1 });
    const legacy: Embedder = { ...fakeEmbedder({ dimensions: 4 }) };
    delete legacy.embedManySettled;
    legacy.embedMany = async () => {
      throw new Error("legacy batch failed");
    };
    const background = prioritizeEmbedder(legacy, resources, "background", 2)!;

    const settled = await background.embedManySettled?.(["a", "b"]);

    expect(settled).toHaveLength(2);
    expect(settled?.every((result) => !result.ok)).toBe(true);
    for (const result of settled ?? []) {
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(MemosError);
        expect(result.error.code).toBe("embedding_unavailable");
        expect(result.error.message).toContain("legacy batch failed");
      }
    }
  });

  it("aborts queued and in-flight provider work during shutdown", async () => {
    const resources = createForegroundResources({ embeddingConcurrency: 1 });
    const base = fakeEmbedder({ dimensions: 4 });
    let providerSignal: AbortSignal | undefined;
    const inner = {
      ...base,
      async embedOne(
        _input: Parameters<typeof base.embedOne>[0],
        options?: Parameters<typeof base.embedOne>[1],
      ) {
        providerSignal = options?.signal;
        return await new Promise<never>((_resolve, reject) => {
          if (options?.signal?.aborted) {
            reject(options.signal.reason);
            return;
          }
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    };
    const background = prioritizeEmbedder(inner, resources, "background")!;
    const pending = background.embedOne("slow background work");
    await Promise.resolve();

    resources.shutdown("test shutdown");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignal?.aborted).toBe(true);
  });
});
