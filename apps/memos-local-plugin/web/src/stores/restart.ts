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
 * Quick health check — verify the server responds again.
 *
 * Hermes' restart flow spawns the new daemon AFTER `sleep 3`
 * (admin.ts) so the old bridge can fully release the viewer port,
 * then `tsx` cold-compiles + bootstrap (DB migrations, embedder /
 * LLM clients, host-bridge registration) takes another few seconds
 * before the port is bound. Total worst-case wall time is ~10–15 s
 * on slower machines. We poll every 1 s for up to 30 attempts (30 s
 * total) so even a sluggish cold start succeeds without the user
 * hitting the "重启超时" toast prematurely.
 */
async function quickPollUp(maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1000));
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

  if (isOpenClaw()) {
    const ok = await pollHealthUntilUp(60);
    if (ok) {
      window.location.href =
        window.location.pathname + "?_t=" + Date.now();
    } else {
      restartState.value = { phase: "restartFailed" };
    }
  } else {
    // Hermes: new daemon spawns after `sleep 3` (admin.ts) so the
    // old bridge can fully release the port; cold-start of tsx +
    // bootstrap may take another few seconds. Use the default
    // `quickPollUp` attempts (30s total).
    const ok = await quickPollUp();
    if (ok) {
      window.location.href =
        window.location.pathname + "?_t=" + Date.now();
    } else {
      restartState.value = { phase: "restartFailed" };
    }
  }
}

/**
 * Data cleared. Both agents self-respawn via the daemon mechanism.
 */
export async function triggerCleared(): Promise<void> {
  restartState.value = { phase: "restarting" };
  if (isOpenClaw()) {
    const ok = await pollHealthUntilUp(60);
    if (ok) {
      window.location.href =
        window.location.pathname + "?_t=" + Date.now();
    } else {
      restartState.value = { phase: "restartFailed" };
    }
  } else {
    // Hermes: clear-data spawns a new daemon. The default 30s of
    // `quickPollUp` already covers the slow first-boot DB migration.
    const ok = await quickPollUp();
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
