/**
 * Config-save restart state manager.
 *
 * Unified flow for all agents: POST `/api/v1/admin/restart` triggers
 * the backend to spawn a fresh daemon bridge and exit. The frontend
 * shows a full-screen spinner and polls `/api/v1/health` until the new
 * process is live, then reloads the page.
 *
 *   - OpenClaw: launchd respawns the gateway automatically.
 *   - Hermes: the restart endpoint spawns `bridge.cts --daemon` before
 *     exiting, so the viewer comes back without user intervention.
 */
import { signal } from "@preact/signals";
import { api } from "../api/client";

export type RestartPhase =
  | "idle"
  | "saved"
  | "cleared"
  | "restarting"
  | "waitingUp"
  | "restartFailed";

export const restartState = signal<{ phase: RestartPhase; message?: string }>({
  phase: "idle",
});

export interface TriggerRestartOptions {
  kick?: "restart-endpoint" | "skip";
}

async function pollHealthUntilUp(maxAttempts = 60): Promise<boolean> {
  let phase: "waitDown" | "waitUp" = "waitDown";
  const MAX_WAIT_DOWN = 8;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const delay = phase === "waitDown" ? 1500 : 2500;
    await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch("/api/v1/health");
      if (phase === "waitDown") {
        if (res.ok || res.status === 401 || res.status === 403) {
          if (attempt >= MAX_WAIT_DOWN) return true;
        } else {
          phase = "waitUp";
          restartState.value = { phase: "waitingUp" };
        }
      } else {
        if (res.ok || res.status === 401 || res.status === 403) return true;
      }
    } catch {
      if (phase === "waitDown") {
        phase = "waitUp";
        restartState.value = { phase: "waitingUp" };
      }
    }
  }
  return false;
}

/**
 * Config saved. Trigger a restart for any agent. The backend spawns a
 * fresh daemon bridge before exiting, so the viewer port comes back up
 * automatically for both OpenClaw (launchd) and Hermes (self-respawn).
 */
export async function triggerRestart(
  _opts: TriggerRestartOptions = {},
): Promise<void> {
  restartState.value = { phase: "restarting" };
  try {
    await api.post("/api/v1/admin/restart");
  } catch {
    // Server might already be going down
  }
  const ok = await pollHealthUntilUp(60);
  if (ok) {
    window.location.href =
      window.location.pathname + "?_t=" + Date.now();
  } else {
    restartState.value = { phase: "restartFailed" };
  }
}

/**
 * Data cleared. Both agents self-respawn via the daemon mechanism.
 */
export async function triggerCleared(): Promise<void> {
  restartState.value = { phase: "restarting" };
  const ok = await pollHealthUntilUp(60);
  if (ok) {
    window.location.href =
      window.location.pathname + "?_t=" + Date.now();
  } else {
    restartState.value = { phase: "restartFailed" };
  }
}

/** Dismiss the banner immediately (e.g. user clicked the close button). */
export function dismissRestartBanner(): void {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  restartState.value = { phase: "idle" };
}
