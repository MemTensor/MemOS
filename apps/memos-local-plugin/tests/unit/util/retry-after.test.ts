import { describe, expect, it } from "vitest";

import {
  clearRetryCooldowns,
  getRetryCooldown,
  parseRetryAfterMs,
  planRetry,
  recordRetryCooldown,
  retryCooldownKey,
} from "../../../core/util/retry-after.js";

describe("parseRetryAfterMs", () => {
  it("parses delay-seconds", () => {
    expect(parseRetryAfterMs("3", 1_000)).toBe(3_000);
    expect(parseRetryAfterMs("0", 1_000)).toBe(0);
  });

  it("parses an HTTP-date relative to the supplied clock", () => {
    const now = Date.parse("2026-08-04T00:00:00.000Z");
    expect(parseRetryAfterMs("Tue, 04 Aug 2026 00:00:05 GMT", now)).toBe(5_000);
  });

  it("clamps past HTTP-dates and rejects malformed values", () => {
    const now = Date.parse("2026-08-04T00:00:00.000Z");
    expect(parseRetryAfterMs("Mon, 03 Aug 2026 23:59:59 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("1.5", now)).toBeNull();
    expect(parseRetryAfterMs("9007199254740991", now)).toBeNull();
    expect(parseRetryAfterMs("later", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });

  it("defers instead of retrying before a long provider Retry-After", () => {
    expect(planRetry({
      attempt: 1,
      baseMs: 200,
      jitterMaxMs: 0,
      retryAfterMs: 120_000,
      maxInlineDelayMs: 30_000,
      nowMs: 1_000,
    })).toEqual({
      action: "defer",
      backoffMs: 200,
      delayMs: 120_000,
      reason: "retry_after_too_long",
      retryAfterMs: 120_000,
      retryAt: 121_000,
      source: "retry_after",
    });
  });

  it("defers when an otherwise short retry cannot fit the request deadline", () => {
    expect(planRetry({
      attempt: 1,
      baseMs: 200,
      jitterMaxMs: 0,
      retryAfterMs: 2_000,
      deadlineAt: 2_500,
      nowMs: 1_000,
    })).toMatchObject({
      action: "defer",
      reason: "deadline_insufficient",
      retryAt: 3_000,
    });
  });

  it("keeps provider cooldowns monotonic and expires them at retryAt", () => {
    clearRetryCooldowns();
    recordRetryCooldown("llm:test", {
      retryAfterMs: 2_000,
      retryAt: 3_000,
      status: 429,
    });
    recordRetryCooldown("llm:test", {
      retryAfterMs: 500,
      retryAt: 1_500,
      status: 503,
    });
    expect(getRetryCooldown("llm:test", 2_999)).toMatchObject({
      retryAt: 3_000,
      status: 429,
    });
    expect(getRetryCooldown("llm:test", 3_000)).toBeNull();
    clearRetryCooldowns();
  });

  it("scopes provider cooldowns by endpoint and model", () => {
    expect(retryCooldownKey("llm", "openai_compatible", "https://x", "model-a"))
      .not.toBe(retryCooldownKey("llm", "openai_compatible", "https://x", "model-b"));
  });
});
