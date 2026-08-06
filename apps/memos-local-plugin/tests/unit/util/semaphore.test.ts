import { describe, expect, it } from "vitest";

import { createSemaphore } from "../../../core/util/semaphore.js";

describe("semaphore", () => {
  it("removes an aborted waiter so shutdown cannot hang behind active work", async () => {
    const semaphore = createSemaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const waiting = semaphore.acquire(controller.signal);

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    release();

    const next = await semaphore.acquire();
    next();
  });
});
