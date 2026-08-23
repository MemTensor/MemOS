/**
 * bridge.mts daemon-mode heartbeat regression guard.
 *
 * Symptom observed 2026-08-22 after deploying memos-local-plugin v2.0.16
 * on a Hermes host: `POST /api/v1/rpc` served traffic normally, but
 * `bridge-status.json` froze at its pre-upgrade timestamp and every health
 * report said `disconnected` / "Hermes bridge heartbeat is stale".
 *
 * Root cause: PR #1998 made the Python launcher prefer the pure-ESM
 * `dist/bridge.mjs` entry (fixing #1736). `bridge.mts` only called
 * `markConnected()` / `startHeartbeat()` in its stdio (`!args.daemon`)
 * branch — the `--daemon` branch never started the status heartbeat, so
 * no daemon ever refreshed `bridge-status.json` and the 20s staleness rule
 * permanently reported a dead bridge. The legacy `bridge.cts` daemon path
 * always had both calls; the ESM successor lost them in translation.
 *
 * Why source-level (rather than runtime): `bridge.mts` is a top-level
 * executable script — same rationale as `bridge-startup-ordering.test.ts`.
 * Refactoring it into an injectable function just to runtime-test two call
 * sites would be a much larger change than this invariant deserves. A
 * source-level assertion catches the regression the moment someone edits
 * the daemon startup path.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_MTS_PATH = resolve(HERE, "..", "..", "..", "bridge.mts");

describe("bridge.mts daemon-mode heartbeat (stale bridge-status.json regression)", () => {
  const src = readFileSync(BRIDGE_MTS_PATH, "utf8");

  // Scope to the daemon branch of main(): from its `if (args.daemon)`
  // guard to the start of the trailing "Normal (stdio) mode" section
  // comment. Scoping matters — markConnected()/startHeartbeat() legitimately
  // appear in the stdio branch and inside the tracker factory, and those
  // must NOT satisfy this guard.
  const daemonGuard = src.indexOf("if (args.daemon)");
  const stdioSection = src.indexOf("Normal (stdio) mode");

  it("has a daemon branch", () => {
    expect(daemonGuard).toBeGreaterThanOrEqual(0);
    expect(stdioSection).toBeGreaterThan(daemonGuard);
  });

  it("marks connected and starts the status heartbeat after binding the viewer port", () => {
    const daemonBranch = src.slice(daemonGuard, stdioSection);

    const connectedIdx = daemonBranch.indexOf("bridgeStatus?.markConnected()");
    expect(
      connectedIdx,
      "bridge.mts: --daemon branch never calls bridgeStatus?.markConnected() — " +
        "the daemon writes no heartbeat and every reader applies the 20s " +
        "staleness rule to a fossilized bridge-status.json, reporting " +
        "'Hermes bridge heartbeat is stale' forever while RPC keeps working.",
    ).toBeGreaterThanOrEqual(0);

    const heartbeatIdx = daemonBranch.indexOf("bridgeHeartbeat = bridgeStatus?.startHeartbeat()");
    expect(
      heartbeatIdx,
      "bridge.mts: --daemon branch never starts the periodic status heartbeat — " +
        "bridge-status.json goes stale immediately after the initial write.",
    ).toBeGreaterThanOrEqual(0);

    // Both calls must sit after the bind-retry loop's `break` (i.e. on the
    // success path); writing "connected" before we know the port bound
    // would lie on the failure paths that exit below.
    const breakIdx = daemonBranch.indexOf("break;");
    expect(breakIdx).toBeGreaterThanOrEqual(0);
    expect(connectedIdx, "markConnected must follow successful viewer bind").toBeGreaterThan(breakIdx);
    expect(heartbeatIdx, "startHeartbeat must follow successful viewer bind").toBeGreaterThan(breakIdx);
  });
});
