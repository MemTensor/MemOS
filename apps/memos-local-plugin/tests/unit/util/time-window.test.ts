import { describe, expect, it } from "vitest";

import {
  isWithinDailyWindow,
  isValidTimezone,
  minuteOfDay,
  parseDailyWindow,
} from "../../../core/util/time-window.js";

/** 2026-09-05 is a Saturday; epoch values chosen to be TZ-agnostic inputs. */
function atUtc(h: number, m: number): number {
  return Date.UTC(2026, 8, 5, h, m, 0);
}

describe("util/time-window.parseDailyWindow", () => {
  it("parses a plain HH:MM-HH:MM window", () => {
    expect(parseDailyWindow("02:00-06:00")).toEqual({
      startMin: 2 * 60,
      endMin: 6 * 60,
    });
  });

  it("tolerates whitespace", () => {
    expect(parseDailyWindow(" 02:00 - 06:00 ")).toEqual({
      startMin: 120,
      endMin: 360,
    });
  });

  it("rejects malformed specs", () => {
    expect(parseDailyWindow("")).toBeNull();
    expect(parseDailyWindow("2-6")).toBeNull();
    expect(parseDailyWindow("02:00–06:00")).toBeNull(); // en dash
    expect(parseDailyWindow("24:00-06:00")).toBeNull();
    expect(parseDailyWindow("02:60-06:00")).toBeNull();
    expect(parseDailyWindow("abc")).toBeNull();
  });
});

describe("util/time-window.minuteOfDay", () => {
  it("uses host-local semantics when timezone is empty", () => {
    // Not asserting a specific value (host TZ varies); just the range.
    const min = minuteOfDay(atUtc(12, 30));
    expect(min).toBeGreaterThanOrEqual(0);
    expect(min).toBeLessThan(1_440);
  });

  it("converts an IANA zone", () => {
    // 12:30 UTC is 20:30 in Asia/Shanghai (UTC+8, no DST).
    expect(minuteOfDay(atUtc(12, 30), "Asia/Shanghai")).toBe(20 * 60 + 30);
    // 12:30 UTC is 08:30 in New York on 2026-09-05 (EDT, UTC-4).
    expect(minuteOfDay(atUtc(12, 30), "America/New_York")).toBe(8 * 60 + 30);
  });

  it("throws for invalid IANA names", () => {
    expect(() => minuteOfDay(atUtc(0, 0), "Not/AZone")).toThrow();
  });
});

describe("util/time-window.isValidTimezone", () => {
  it("accepts empty and valid zones", () => {
    expect(isValidTimezone("")).toBe(true);
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
  });

  it("rejects invalid zones", () => {
    expect(isValidTimezone("Not/AZone")).toBe(false);
  });
});

describe("util/time-window.isWithinDailyWindow", () => {
  // Explicit UTC keeps the window semantics independent of the host TZ.
  const day = parseDailyWindow("02:00-06:00")!;
  const night = parseDailyWindow("23:00-07:00")!;

  it("is inclusive of start and exclusive of end", () => {
    expect(isWithinDailyWindow(atUtc(2, 0), day, "UTC")).toBe(true);
    expect(isWithinDailyWindow(atUtc(1, 59), day, "UTC")).toBe(false);
    expect(isWithinDailyWindow(atUtc(5, 59), day, "UTC")).toBe(true);
    expect(isWithinDailyWindow(atUtc(6, 0), day, "UTC")).toBe(false);
  });

  it("never matches a zero-length window", () => {
    const zero = parseDailyWindow("02:00-02:00")!;
    expect(isWithinDailyWindow(atUtc(2, 0), zero, "UTC")).toBe(false);
  });

  it("supports overnight wrap", () => {
    expect(isWithinDailyWindow(atUtc(23, 0), night, "UTC")).toBe(true);
    expect(isWithinDailyWindow(atUtc(3, 0), night, "UTC")).toBe(true);
    expect(isWithinDailyWindow(atUtc(6, 59), night, "UTC")).toBe(true);
    expect(isWithinDailyWindow(atUtc(7, 0), night, "UTC")).toBe(false);
    expect(isWithinDailyWindow(atUtc(12, 0), night, "UTC")).toBe(false);
  });

  it("evaluates in the configured timezone", () => {
    // 18:30 UTC = 02:30 next day in Shanghai → inside 02:00-06:00 there.
    expect(isWithinDailyWindow(atUtc(18, 30), day, "Asia/Shanghai")).toBe(true);
    // Same instant in New York is 14:30 → outside the window.
    expect(isWithinDailyWindow(atUtc(18, 30), day, "America/New_York")).toBe(false);
  });

  it("never matches a null (invalid) window", () => {
    expect(isWithinDailyWindow(atUtc(3, 0), null)).toBe(false);
  });
});
