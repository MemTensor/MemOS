import { describe, expect, it } from "vitest";

import {
  MAX_HTTP_PAGE_LIMIT,
  parseLimitParam,
} from "../../../server/routes/params.js";

// Boundary cap for untrusted `limit` input: storage-level `clampLimit`
// honors explicit limits up to MAX_QUERY_LIMIT (#2401), so routes must
// keep caller-supplied page sizes at the 500-row ceiling these endpoints
// had before that change — otherwise a `?limit=100000` request could pull
// up to MAX_QUERY_LIMIT rows in one round-trip.
describe("server/routes/params — parseLimitParam", () => {
  it("falls back to the default for missing or invalid input", () => {
    expect(parseLimitParam(null)).toBe(50);
    expect(parseLimitParam(undefined as unknown as null)).toBe(50);
    expect(parseLimitParam("")).toBe(50);
    expect(parseLimitParam("abc")).toBe(50);
    expect(parseLimitParam("0")).toBe(50);
    expect(parseLimitParam("-5")).toBe(50);
    expect(parseLimitParam("Infinity")).toBe(50);
    expect(parseLimitParam(null, 20)).toBe(20);
  });

  it("accepts positive integers", () => {
    expect(parseLimitParam("1")).toBe(1);
    expect(parseLimitParam("50")).toBe(50);
    expect(parseLimitParam(String(MAX_HTTP_PAGE_LIMIT))).toBe(
      MAX_HTTP_PAGE_LIMIT,
    );
  });

  it("clamps oversized values to MAX_HTTP_PAGE_LIMIT", () => {
    expect(parseLimitParam("501")).toBe(MAX_HTTP_PAGE_LIMIT);
    expect(parseLimitParam("10000")).toBe(MAX_HTTP_PAGE_LIMIT);
    expect(parseLimitParam("1e9")).toBe(MAX_HTTP_PAGE_LIMIT);
  });

  it("truncates fractional values", () => {
    expect(parseLimitParam("10.9")).toBe(10);
    expect(parseLimitParam("500.5")).toBe(MAX_HTTP_PAGE_LIMIT);
  });
});
