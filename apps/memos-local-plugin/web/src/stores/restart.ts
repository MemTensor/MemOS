/**
 * Global restart-coordinator — signal-based so any view can trigger a
 * graceful reload.
 *
 * Workflow:
 *   1. `triggerRestart()` sets `restarting.value = { phase: 'down' }`
 *   2. App-shell renders a full-screen overlay driven by the signal.
 *   3. We POST `/api/v1/admin/restart` — the server flushes the
 *      response, closes the HTTP server, and `process.exit(0)`s.
 *   4. We poll `GET /api/v1/health` every 1.5s. First transition
 *      "ok → fail" flips phase to `up`; first "fail → ok" transition
 *      during phase=up flips to `done` and reloads the page.
 *
 * If the server doesn't come back within `MAX_ATTEMPTS * POLL_MS`
 * (~90s), we surface a hard-error message and stop polling.
 */
import { signal } from "@preact/signals";
import { withAgentPrefix } from "../api/client";

export type RestartPhase = "idle" | "down" | "up" | "done" | "failed";

export const restartState = signal<{ phase: RestartPhase; message?: string }>({
  phase: "idle",
});

const POLL_MS = 1500;
const MAX_ATTEMPTS = 60;

async function probe(): Promise<boolean> {
  try {
    const r = await fetch(withAgentPrefix("/api/v1/health"), { cache: "no-store" });
    if (!r.ok) return false;
    const body = (await r.json()) as { ok?: boolean };
    return !!body?.ok;
  } catch {
    return false;
  }
}

export interface TriggerRestartOptions {
  /**
   * What kicks the server into exiting. Defaults to hitting
   * `POST /api/v1/admin/restart`; callers that already fired a different
   * endpoint (e.g. "Clear all data", which the server handles by
   * wiping SQLite + `process.exit(0)`) should pass `"skip"` so we don't
   * double-trigger.
   */
  kick?: "restart-endpoint" | "skip";
}

export async function triggerRestart(
  opts: TriggerRestartOptions = {},
): Promise<void> {
  restartState.value = { phase: "down" };

  if ((opts.kick ?? "restart-endpoint") === "restart-endpoint") {
    try {
      await fetch(withAgentPrefix("/api/v1/admin/restart"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      // That's expected — the server may have closed the socket as it
      // shut down. Continue to the poll loop.
    }
  }

  // Phase 1 — wait for the server to go offline so we know the
  // restart request actually took effect.
  let wentDown = false;
  for (let i = 0; i < 20; i++) {
    await sleep(POLL_MS / 3);
    const alive = await probe();
    if (!alive) {
      wentDown = true;
      break;
    }
  }
  if (!wentDown) {
    // Config was patched but the server never restarted — most likely
    // dev mode without a supervisor. Force a reload so the viewer
    // picks up the new config via the normal REST path.
    restartState.value = { phase: "done" };
    location.reload();
    return;
  }

  restartState.value = { phase: "up" };

  // Phase 2 — wait for the server to come back.
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await sleep(POLL_MS);
    const alive = await probe();
    if (alive) {
      restartState.value = { phase: "done" };
      location.reload();
      return;
    }
  }

  restartState.value = {
    phase: "failed",
    message:
      "Service didn't come back in time. The plugin host may need a manual restart.",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
