import { afterEach, describe, expect, it, vi } from "vitest";

import { createRequestDeadline } from "../../../core/util/request-deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createRequestDeadline", () => {
  it("aborts at the absolute deadline and reports no remaining budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const deadline = createRequestDeadline(1_250);
    expect(deadline.remainingMs()).toBe(250);
    expect(deadline.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(250);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
    deadline.dispose();
  });

  it("treats an already-expired deadline as immediately aborted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    const deadline = createRequestDeadline(1_999);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
    deadline.dispose();
  });
});
