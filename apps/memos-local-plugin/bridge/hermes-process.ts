/**
 * Hermes chat process detection.
 *
 * The viewer daemon (`bridge.cts --daemon`) wants to know whether the
 * user has a `hermes chat` session attached to *some* bridge stdio
 * process so it can upgrade its own `"disconnected"` status to
 * `"reconnecting"` instead of leaving the viewer permanently red.
 *
 * Implementation: shell out to `pgrep -f <regex>`. The regex has to
 * cover all three CLI invocation shapes the Hermes CLI supports:
 *
 *   • no flags                    — `hermes chat`
 *   • flags after the subcommand  — `hermes chat --skills memory-routing`
 *   • global flags before it      — `hermes --skills memory-routing chat`
 *
 * The third shape is the bug reported in #1915: the previous literal
 * pattern `"hermes chat"` requires the two tokens to be contiguous and
 * therefore misses any invocation with a global flag (`--skills`,
 * `-m`, `--provider`, …) between them.
 *
 * The current pattern is `hermes(?:\s+\S+)*\s+chat\b`:
 *
 *   • `hermes`           — the binary basename.
 *   • `(?:\s+\S+)*`      — any complete argv-style tokens between the
 *     binary and the subcommand.
 *   • `\s+chat\b`        — a standalone `chat` token, so it does *not*
 *     match `chatter`, `chat-server`, `--chat-log`, or a flag value
 *     like `--profile=chat`.
 *
 * `pgrep -f` on Linux uses glibc's ERE engine, which supports
 * `\s`/`\b` as GNU extensions. JavaScript's `RegExp` supports the same
 * tokens natively, so this module also exports
 * `matchesHermesChatCommandLine()` for unit tests — exercising the
 * pattern as a JS regex is a faithful proxy for the pgrep-side
 * behaviour without requiring a real Hermes binary or a fork of the
 * pgrep process in CI.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as childProcess from "node:child_process";

/**
 * pgrep `-f` pattern used by `isHermesChatRunning`.
 *
 * Exported separately so callers — and tests — can introspect the exact
 * string we hand to `pgrep` and confirm we have not silently regressed
 * back to a literal substring match.
 */
export const HERMES_CHAT_PROCESS_PATTERN = "hermes(?:\\s+\\S+)*\\s+chat\\b";

/**
 * JS-side equivalent of `pgrep -f HERMES_CHAT_PROCESS_PATTERN`.
 *
 * Used by unit tests to verify the regex matches every documented
 * Hermes invocation shape and rejects unrelated command lines. Kept
 * deliberately stateless — callers should pass the full
 * `/proc/<pid>/cmdline`-style command-line string.
 */
export function matchesHermesChatCommandLine(commandLine: string): boolean {
  return new RegExp(HERMES_CHAT_PROCESS_PATTERN).test(commandLine);
}

/**
 * Shape of the `execFileSync`-compatible helper that
 * `isHermesChatRunning` shells out through. Carved out as a named type
 * so tests can pass a `vi.fn()` without depending on Node's overloaded
 * `ExecFileSyncOptions` union.
 */
export type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number },
) => string;

const defaultExecFileSync: ExecFileSyncLike = (file, args, options) =>
  childProcess.execFileSync(file, [...args], options) as unknown as string;

/**
 * Returns `true` when `pgrep -f` finds at least one process whose full
 * command line matches `HERMES_CHAT_PROCESS_PATTERN`.
 *
 * `pgrep` exits non-zero when there is no match, when it cannot be
 * found, or on permission errors — all of which we collapse into
 * `false` because the caller only uses the boolean to decide whether
 * to upgrade `"disconnected"` to `"reconnecting"`. Surfacing the
 * difference would just turn a UI hint into a noisy crash path.
 *
 * `execFile` is overridable so the unit test can inject a stub instead
 * of mocking `node:child_process` globally — a Node ESM namespace is
 * frozen at import time, so spy-based mocking is brittle. Injection is
 * the same dependency pattern the rest of the bridge uses (see
 * `startStdioServer`'s `stdin` / `stdout` options).
 */
export function isHermesChatRunning(
  execFile: ExecFileSyncLike = defaultExecFileSync,
): boolean {
  try {
    const out = execFile("pgrep", ["-f", HERMES_CHAT_PROCESS_PATTERN], {
      encoding: "utf8",
      timeout: 1000,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
