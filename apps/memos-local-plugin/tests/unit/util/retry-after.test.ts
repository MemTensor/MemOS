import { describe, expect, it } from "vitest";

import { parseRetryAfterMs, retryDelayMs } from "../../../core/util/retry-after.js";

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

  it("caps a provider supplied Retry-After before scheduling a timer", () => {
    expect(retryDelayMs({
      attempt: 1,
      baseMs: 200,
      jitterMaxMs: 0,
      retryAfterMs: 120_000,
      maxDelayMs: 30_000,
    })).toBe(30_000);
  });
});
