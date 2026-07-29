import { describe, it, expect, beforeEach } from "vitest";
import {
  enterForeground,
  isForegroundPending,
  yieldIfForegroundPending,
} from "../../../core/embedding/priority-gate.js";

describe("priority-gate", () => {
  beforeEach(() => {
    // Drain any leftover foreground counts from prior tests.
    while (isForegroundPending()) {
      // Force-release by entering and releasing.
      const r = enterForeground();
      r();
      // If still pending after one release, something is wrong — break to
      // avoid infinite loop in test.
      break;
    }
  });

  it("starts with no foreground pending", () => {
    expect(isForegroundPending()).toBe(false);
  });

  it("enterForeground increments and release decrements", () => {
    const release = enterForeground();
    expect(isForegroundPending()).toBe(true);
    release();
    expect(isForegroundPending()).toBe(false);
  });

  it("multiple foreground calls stack", () => {
    const r1 = enterForeground();
    const r2 = enterForeground();
    expect(isForegroundPending()).toBe(true);
    r1();
    expect(isForegroundPending()).toBe(true);
    r2();
    expect(isForegroundPending()).toBe(false);
  });

  it("release is idempotent", () => {
    const release = enterForeground();
    release();
    release(); // double-release should not go negative
    expect(isForegroundPending()).toBe(false);
  });

  it("yieldIfForegroundPending resolves immediately when no foreground", async () => {
    const t0 = Date.now();
    await yieldIfForegroundPending();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("yieldIfForegroundPending yields via setImmediate when foreground pending", async () => {
    const release = enterForeground();
    let yielded = false;
    const yieldPromise = yieldIfForegroundPending().then(() => {
      yielded = true;
    });
    // Before the microtask/setImmediate fires, yielded should be false.
    expect(yielded).toBe(false);
    await yieldPromise;
    expect(yielded).toBe(true);
    release();
  });
});
