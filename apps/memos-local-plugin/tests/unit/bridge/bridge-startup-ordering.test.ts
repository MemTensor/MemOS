/**
 * bridge.cts startup-ordering regression guard for issue #1747.
 *
 * Issue summary: when `core.init()` ran before `startStdioServer({ core })`
 * in `bridge.cts`'s non-daemon (stdio) startup path, orphan-episode
 * recovery (LLM-driven reward grading inside `core.init()`) could take
 * 10-60+ seconds. While that ran, the stdio JSON-RPC read loop was not
 * yet attached to `process.stdin`, so the Hermes Python adapter's
 * `session.open` RPC sat unread in the pipe buffer until its 30 s
 * `_open_session()` timeout fired with `asyncio.TimeoutError`.
 *
 * The fix landed in commit 7c6bd250 (May 2026) — `startStdioServer` now
 * runs first. This test pins that invariant so a future refactor can't
 * silently re-introduce the race.
 *
 * Why source-level (rather than runtime): `bridge.cts` is a top-level
 * executable script — refactoring it into an injectable function just
 * to runtime-test the ordering would be a much larger change than the
 * invariant deserves. A source-level assertion catches the regression
 * at the moment a developer rearranges the ordering, which is exactly
 * what the issue asks us to prevent.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_CTS_PATH = resolve(HERE, "..", "..", "..", "bridge.cts");

describe("bridge.cts startup ordering (regression guard for #1747)", () => {
  const src = readFileSync(BRIDGE_CTS_PATH, "utf8");

  it("starts the stdio JSON-RPC server before awaiting core.init() in non-daemon mode", () => {
    // Match the assignment form `stdio = startStdioServer({ core })`
    // and the call form `await core.init();` (with trailing semicolon).
    // Both substrings appear *only* at the real call sites, never in
    // the surrounding rationale comments (which use bare
    // `startStdioServer({ core })` and `await core.init()` in prose).
    const stdioIdx = src.indexOf("stdio = startStdioServer({ core })");
    const initIdx = src.indexOf("await core.init();");

    expect(stdioIdx, "stdio = startStdioServer({ core }) call site not found").toBeGreaterThanOrEqual(0);
    expect(initIdx, "await core.init(); call site not found").toBeGreaterThanOrEqual(0);
    expect(
      stdioIdx,
      `bridge.cts: stdio = startStdioServer({ core }) must appear textually before await core.init(); ` +
        `(stdioIdx=${stdioIdx} initIdx=${initIdx}). ` +
        `Reordering reopens the issue #1747 race where the Python adapter's ` +
        `session.open RPC times out while orphan recovery blocks the stdio reader.`,
    ).toBeLessThan(initIdx);
  });

  it("keeps the stdio start guarded inside the !args.daemon branch", () => {
    // Daemon mode (--daemon) intentionally skips stdio entirely and runs
    // as a pure HTTP viewer. We want the regression guard to apply to
    // the stdio (non-daemon) path only — moving the call outside the
    // guard would re-enable stdio in daemon mode, which is a separate
    // breaking change. This test pins the guard's presence.
    const stdioIdx = src.indexOf("stdio = startStdioServer({ core })");
    expect(stdioIdx).toBeGreaterThanOrEqual(0);

    const before = src.slice(0, stdioIdx);
    const lastDaemonGuard = before.lastIndexOf("if (!args.daemon)");
    expect(
      lastDaemonGuard,
      "bridge.cts: stdio = startStdioServer({ core }) must remain inside an `if (!args.daemon)` block",
    ).toBeGreaterThanOrEqual(0);
  });
});
