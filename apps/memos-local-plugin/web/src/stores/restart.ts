/**
 * Config-save restart state manager.
 *
 * Unified flow for all agents: POST `/api/v1/admin/restart` triggers
 * the backend to spawn a fresh daemon bridge and exit. The frontend
 * polls `/api/v1/health` until the new process is live, then reloads.
 *
 *   - OpenClaw: launchd respawns the gateway — may take a few seconds.
 *   - Hermes: the restart endpoint spawns `bridge.cts --daemon` before
 *     exiting, so the viewer comes back almost immediately.
 */
import { signal } from "@preact/signals";
import { api } from "../api/client";
import { health } from "./health";

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

function isOpenClaw(): boolean {
  return health.value?.agent === "openclaw";
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
 * Quick health check — just verify the server responds once.
 * Used for Hermes where the new daemon is already up before the old exits.
 */
async function quickPollUp(maxAttempts = 10): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      const res = await fetch("/api/v1/health");
      if (res.ok || res.status === 401 || res.status === 403) return true;
    } catch {
      /* server still transitioning */
    }
  }
  return false;
}

/**
 * Config saved. Trigger a restart.
 *
 * - OpenClaw: always restarts (launchd respawns).
 * - Hermes daemon mode: restarts (spawn new daemon, exit old).
 * - Hermes stdio mode (hermes chat running): does NOT restart —
 *   config is saved to disk, health() reads from disk, and the
 *   memory capture pipeline stays intact. Just reload the page.
 */
export async function triggerRestart(
  _opts: TriggerRestartOptions = {},
): Promise<void> {
  restartState.value = { phase: "restarting" };
  let response: { restarting?: boolean } = { restarting: true };
  try {
    response = await api.post<{ restarting?: boolean }>("/api/v1/admin/restart");
  } catch {
    // Server might already be going down
  }

  if (!response.restarting) {
    // Stdio mode: server stayed up, config saved. Just reload.
    window.location.href =
      window.location.pathname + "?_t=" + Date.now();
    return;
  }

  if (isOpenClaw()) {
    const ok = await pollHealthUntilUp(60);
    if (ok) {
      window.location.href =
        window.location.pathname + "?_t=" + Date.now();
    } else {
      restartState.value = { phase: "restartFailed" };
    }
  } else {
    const ok = await quickPollUp(10);
    if (ok) {
      window.location.href =
        window.location.pathname + "?_t=" + Date.now();
    } else {
      restartState.value = { phase: "restartFailed" };
    }
  }
}

/**
 * Data cleared. Same logic: daemon restarts, stdio stays alive.
 */
export async function triggerCleared(): Promise<void> {
  restartState.value = { phase: "restarting" };

  // The clear-data endpoint handles the restart logic server-side.
  // If it returns restarting:false, the server stayed up (stdio mode).
  let response: { restarting?: boolean } = { restarting: true };
  try {
    response = await api.post<{ restarting?: boolean }>("/api/v1/admin/clear-data");
  } catch {
    // might already be going down
  }

  if (!response.restarting) {
    window.location.href =
      window.location.pathname + "?_t=" + Date.now();
    return;
  }

  if (isOpenClaw()) {
    const ok = await pollHealthUntilUp(60);
    if (ok) {
      window.location.href =
        window.location.pathname + "?_t=" + Date.now();
    } else {
      restartState.value = { phase: "restartFailed" };
    }
  } else {
    const ok = await quickPollUp(15);
    if (ok) {
      window.location.href =
        window.location.pathname + "?_t=" + Date.now();
    } else {
      restartState.value = { phase: "restartFailed" };
    }
  }
}

/** Dismiss the banner immediately (e.g. user clicked the close button). */
export function dismissRestartBanner(): void {
  restartState.value = { phase: "idle" };
}
