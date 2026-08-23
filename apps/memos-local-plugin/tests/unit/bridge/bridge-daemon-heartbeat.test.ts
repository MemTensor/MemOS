/**
 * bridge.mts / bridge.cts daemon heartbeat regression guard for issue #2278.
 *
 * Issue summary: since PR #1998 the Hermes launcher prefers the pure-ESM
 * `dist/bridge.mjs` entry (built from `bridge.mts`). In `bridge.mts` the
 * `bridge-status.json` heartbeat was only started in the **stdio** branch
 * (`if (!args.daemon)`); the `--daemon` branch never called
 * `markConnected()` / `startHeartbeat()`. A daemon-spawned bridge therefore
 * never refreshed the status file, and the health endpoint permanently
 * reported `status: "disconnected"` / "Hermes bridge heartbeat is stale"
 * ~20 s after the last (possibly pre-upgrade) write — while RPC kept
 * working.
 *
 * The legacy `bridge.cts` daemon path has the same gap (it was never called
 * there, even in the original signal-light commit 22ccacbf), so both entries
 * are guarded here.
 *
 * Why source-level (rather than runtime): both `bridge.mts` and `bridge.cts`
 * are top-level executable scripts; refactoring them into injectable
 * functions just to runtime-test the heartbeat would be a much larger change
 * than the invariant deserves. A source-level assertion catches the
 * regression at the moment a developer removes the daemon-side calls — which
 * is exactly what the issue asks us to prevent. Same pattern as
 * `bridge-startup-ordering.test.ts` (#1747).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..", "..", "..");
const BRIDGE_MTS_PATH = resolve(PLUGIN_ROOT, "bridge.mts");
const BRIDGE_CTS_PATH = resolve(PLUGIN_ROOT, "bridge.cts");

/**
 * Assert that the daemon branch of `src` starts the status heartbeat.
 *
 * The stdio branch (`if (!args.daemon)`) textually precedes the daemon
 * branch (`if (args.daemon)`), so every daemon-side call must sit at an
 * index AFTER the daemon guard's `if (args.daemon)`. The stdio block's own
 * `markConnected()` sits before it and must remain in place too.
 */
function expectDaemonHeartbeat(src: string, entryName: string): void {
  const stdioGuardIdx = src.indexOf("if (!args.daemon)");
  const daemonGuardIdx = src.indexOf("if (args.daemon)");

  expect(
    stdioGuardIdx,
    `${entryName}: stdio guard "if (!args.daemon)" not found`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    daemonGuardIdx,
    `${entryName}: daemon guard "if (args.daemon)" not found`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    daemonGuardIdx,
    `${entryName}: daemon guard must appear after the stdio guard ` +
      `(stdioGuardIdx=${stdioGuardIdx} daemonGuardIdx=${daemonGuardIdx}). ` +
      `If the branch structure changed, re-check the ordering assertion.`,
  ).toBeGreaterThan(stdioGuardIdx);

  const markIdx = src.indexOf("bridgeStatus?.markConnected();", daemonGuardIdx);
  const heartbeatIdx = src.indexOf(
    "bridgeHeartbeat = bridgeStatus?.startHeartbeat();",
    daemonGuardIdx,
  );

  expect(
    markIdx,
    `${entryName}: bridgeStatus?.markConnected(); must be called inside the ` +
      `daemon branch (after "if (args.daemon)"). Removing it reopens issue ` +
      `#2278: a --daemon bridge never refreshes bridge-status.json and the ` +
      `health endpoint reports "Hermes bridge heartbeat is stale" forever ` +
      `while RPC still works.`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    heartbeatIdx,
    `${entryName}: bridgeHeartbeat = bridgeStatus?.startHeartbeat(); must be ` +
      `called inside the daemon branch. Same issue #2278 rationale as above.`,
  ).toBeGreaterThanOrEqual(0);

  // The stdio branch keeps its own heartbeat start — the fix must ADD
  // daemon-side calls, not relocate the stdio ones.
  const stdioMarkIdx = src.indexOf("bridgeStatus?.markConnected();", stdioGuardIdx);
  expect(
    stdioMarkIdx,
    `${entryName}: the stdio branch (if (!args.daemon)) must keep its own ` +
      `bridgeStatus?.markConnected(); call`,
  ).toBeGreaterThanOrEqual(0);
  expect(stdioMarkIdx).toBeLessThan(daemonGuardIdx);
}

describe("bridge daemon status heartbeat (regression guard for #2278)", () => {
  it("bridge.mts starts the status heartbeat in the --daemon branch", () => {
    expectDaemonHeartbeat(readFileSync(BRIDGE_MTS_PATH, "utf8"), "bridge.mts");
  });

  it("bridge.cts starts the status heartbeat in the --daemon branch (parity)", () => {
    expectDaemonHeartbeat(readFileSync(BRIDGE_CTS_PATH, "utf8"), "bridge.cts");
  });
});
