import { describe, expect, it } from "vitest";

import { parseRetryAfterMs } from "../../../core/util/retry-after.js";

function respWith(headerValue: string | null): Response {
  const headers = new Headers();
  if (headerValue !== null) headers.set("Retry-After", headerValue);
  return new Response(null, { status: 429, headers });
}

describe("util/parseRetryAfterMs", () => {
  it("returns null when header is absent", () => {
    expect(parseRetryAfterMs(respWith(null), 60_000)).toBeNull();
  });

  it("parses delta-seconds (integer) into milliseconds", () => {
    expect(parseRetryAfterMs(respWith("3"), 60_000)).toBe(3_000);
    expect(parseRetryAfterMs(respWith("0"), 60_000)).toBe(0);
  });

  it("caps delta-seconds at capMs", () => {
    expect(parseRetryAfterMs(respWith("9999"), 60_000)).toBe(60_000);
  });

  it("parses HTTP-date in the near future", () => {
    const target = new Date(Date.now() + 2_000);
    const ms = parseRetryAfterMs(respWith(target.toUTCString()), 60_000);
    expect(ms).not.toBeNull();
    // Allow generous slack for the elapsed parsing time.
    expect(ms!).toBeGreaterThan(500);
    expect(ms!).toBeLessThanOrEqual(2_500);
  });

  it("returns null when HTTP-date is in the past", () => {
    const target = new Date(Date.now() - 60_000);
    expect(parseRetryAfterMs(respWith(target.toUTCString()), 60_000)).toBeNull();
  });

  it("caps HTTP-date diff at capMs", () => {
    const target = new Date(Date.now() + 10 * 60 * 1000);
    expect(parseRetryAfterMs(respWith(target.toUTCString()), 60_000)).toBe(60_000);
  });

  it("returns null for malformed values", () => {
    expect(parseRetryAfterMs(respWith("not-a-number"), 60_000)).toBeNull();
    expect(parseRetryAfterMs(respWith(""), 60_000)).toBeNull();
    expect(parseRetryAfterMs(respWith("   "), 60_000)).toBeNull();
  });

  it("rejects negative-looking values (no leading sign permitted)", () => {
    // The integer regex `^\d+$` does not match `-1`, so it falls through to
    // Date.parse which will return NaN for `-1` → null.
    expect(parseRetryAfterMs(respWith("-1"), 60_000)).toBeNull();
  });
});
