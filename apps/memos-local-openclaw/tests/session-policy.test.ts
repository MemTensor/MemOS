import { describe, expect, it } from "vitest";
import { shouldSkipAutoRecallForSession } from "../src/recall/session-policy";

describe("shouldSkipAutoRecallForSession", () => {
  it("skips cron session keys with default config (excludeCron defaults to true)", () => {
    expect(shouldSkipAutoRecallForSession("agent:main:cron:job-abc", undefined)).toBe(true);
    expect(shouldSkipAutoRecallForSession("agent:main:cron:job-abc", {})).toBe(true);
  });

  it("matches the `cron` segment regardless of position", () => {
    expect(shouldSkipAutoRecallForSession("cron:tick-1", {})).toBe(true);
    expect(shouldSkipAutoRecallForSession("agent:alpha:cron", {})).toBe(true);
    expect(shouldSkipAutoRecallForSession("CRON:Job-9", {})).toBe(true); // case-insensitive
  });

  it("does NOT match identifiers that merely contain the substring `cron`", () => {
    // boundary guard: 'cronos' is its own word, 'chat-cron-debug' uses '-' not ':'
    expect(shouldSkipAutoRecallForSession("agent:main:chat:cronos", {})).toBe(false);
    expect(shouldSkipAutoRecallForSession("agent:main:chat-cron-debug", {})).toBe(false);
  });

  it("does NOT skip regular chat sessions", () => {
    expect(shouldSkipAutoRecallForSession("agent:main:chat:hello", {})).toBe(false);
    expect(shouldSkipAutoRecallForSession("default", {})).toBe(false);
  });

  it("returns false when sessionKey is missing or empty (no opinion)", () => {
    expect(shouldSkipAutoRecallForSession(undefined, {})).toBe(false);
    expect(shouldSkipAutoRecallForSession("", {})).toBe(false);
  });

  it("respects excludeCron=false to keep cron auto-recall enabled", () => {
    expect(
      shouldSkipAutoRecallForSession("agent:main:cron:abc", { excludeCron: false }),
    ).toBe(false);
  });

  it("applies user-supplied regex patterns from excludeSessionKeyPatterns", () => {
    expect(
      shouldSkipAutoRecallForSession("agent:debug:gateway:hello", {
        excludeCron: false,
        excludeSessionKeyPatterns: ["^agent:debug:"],
      }),
    ).toBe(true);

    expect(
      shouldSkipAutoRecallForSession("agent:main:chat:hello", {
        excludeCron: false,
        excludeSessionKeyPatterns: ["^agent:debug:"],
      }),
    ).toBe(false);
  });

  it("falls back gracefully when a regex pattern is invalid", () => {
    // '[' is an invalid regex; should be ignored, not throw
    expect(() =>
      shouldSkipAutoRecallForSession("agent:main:chat:hello", {
        excludeCron: false,
        excludeSessionKeyPatterns: ["["],
      }),
    ).not.toThrow();
    expect(
      shouldSkipAutoRecallForSession("agent:main:chat:hello", {
        excludeCron: false,
        excludeSessionKeyPatterns: ["["],
      }),
    ).toBe(false);
  });

  it("combines excludeCron and excludeSessionKeyPatterns (OR semantics)", () => {
    expect(
      shouldSkipAutoRecallForSession("agent:main:cron:abc", {
        excludeCron: true,
        excludeSessionKeyPatterns: ["nope"],
      }),
    ).toBe(true);
  });
});
