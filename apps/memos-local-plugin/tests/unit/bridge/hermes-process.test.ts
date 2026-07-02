/**
 * Hermes foreground process detection — regex + pgrep wrapper.
 *
 * Regression for #1915: the daemon-mode bridge's `applyStaleRule()`
 * used `pgrep -f "hermes chat"` as a literal substring, so any
 * invocation with a global flag between the binary and the
 * subcommand (`hermes --skills memory-routing chat`) was silently
 * missed and the viewer was stuck on `"disconnected"`.
 *
 * The pattern under test is `hermes(?:\s+\S+)*\s+(?:chat|gateway)\b`
 * — these cases lock in the exact shape of the fix.
 */
import { describe, expect, it, vi } from "vitest";

import {
  HERMES_CHAT_PROCESS_PATTERN,
  isHermesChatRunning,
  matchesHermesChatCommandLine,
} from "../../../bridge/hermes-process.js";

describe("HERMES_CHAT_PROCESS_PATTERN", () => {
  it("is the documented #1915 regex (locks in the wire format pgrep sees)", () => {
    // If this string ever changes, audit `bridge.cts` callers and the
    // issue description before adjusting — the constant is the only
    // surface that fixes the substring-detection bug.
    expect(HERMES_CHAT_PROCESS_PATTERN).toBe(
      "hermes(?:\\s+\\S+)*\\s+(?:chat|gateway)\\b",
    );
  });
});

describe("matchesHermesChatCommandLine", () => {
  // ─── positive cases (must match) ───────────────────────────────
  it("matches plain `hermes chat` with no flags", () => {
    expect(
      matchesHermesChatCommandLine("/usr/local/bin/hermes chat"),
    ).toBe(true);
  });

  it("matches `hermes chat --skills …` (chat-level flags, the old happy path)", () => {
    expect(
      matchesHermesChatCommandLine(
        "/usr/local/bin/hermes chat --skills memory-routing",
      ),
    ).toBe(true);
  });

  it("matches `hermes --skills … chat` (global long flag before subcommand) — #1915", () => {
    expect(
      matchesHermesChatCommandLine(
        "/usr/local/lib/hermes-agent/venv/bin/hermes --skills memory-routing chat",
      ),
    ).toBe(true);
  });

  it("matches `hermes -m gpt-4 chat` (global short flag before subcommand) — #1915", () => {
    expect(
      matchesHermesChatCommandLine("/usr/local/bin/hermes -m gpt-4 chat"),
    ).toBe(true);
  });

  it("matches `hermes --provider openai --skills mem chat` (multiple global flags) — #1915", () => {
    expect(
      matchesHermesChatCommandLine(
        "/usr/local/bin/hermes --provider openai --skills mem chat",
      ),
    ).toBe(true);
  });

  it("matches `hermes gateway` foreground sessions — #1813", () => {
    expect(
      matchesHermesChatCommandLine("/usr/local/bin/hermes gateway"),
    ).toBe(true);
    expect(
      matchesHermesChatCommandLine(
        "/usr/local/bin/hermes --skills memory-routing gateway",
      ),
    ).toBe(true);
  });

  // ─── negative cases (must NOT match) ───────────────────────────
  it("does not match `hermes status` (different subcommand)", () => {
    expect(
      matchesHermesChatCommandLine("/usr/local/bin/hermes status"),
    ).toBe(false);
  });

  it("does not match `hermes chatter` (chat must end at a word boundary)", () => {
    expect(
      matchesHermesChatCommandLine("/usr/local/bin/hermes chatter"),
    ).toBe(false);
  });

  it("does not match `hermes --chat-log=... status` (chat must be the subcommand token)", () => {
    expect(
      matchesHermesChatCommandLine(
        "/usr/local/bin/hermes --chat-log=/tmp/history status",
      ),
    ).toBe(false);
  });

  it("does not match a process with neither `hermes` nor `chat`", () => {
    expect(matchesHermesChatCommandLine("/bin/bash -c sleep 5")).toBe(false);
  });

  it("does not match `hermesctl …` (binary name needs a whitespace separator)", () => {
    // Catches the foot-gun of dropping the `\s` anchor and matching
    // `hermesctl --chat-log=...` against the pattern.
    expect(
      matchesHermesChatCommandLine("/usr/local/bin/hermesctl --chat-log=foo"),
    ).toBe(false);
  });
});

describe("isHermesChatRunning", () => {
  it("calls pgrep with the documented #1915 regex pattern", () => {
    const spy = vi.fn().mockReturnValue("12345\n");
    expect(isHermesChatRunning(spy)).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      "pgrep",
      ["-f", HERMES_CHAT_PROCESS_PATTERN],
      { encoding: "utf8", timeout: 1000 },
    );
  });

  it("returns false when pgrep prints only whitespace (no match)", () => {
    const spy = vi.fn().mockReturnValue("\n");
    expect(isHermesChatRunning(spy)).toBe(false);
  });

  it("returns false when pgrep throws (e.g. exit 1 on no match, binary missing)", () => {
    const spy = vi.fn().mockImplementation(() => {
      throw new Error("Command failed with exit code 1");
    });
    expect(isHermesChatRunning(spy)).toBe(false);
  });
});
