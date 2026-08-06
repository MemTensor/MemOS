import { describe, expect, it } from "vitest";

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
