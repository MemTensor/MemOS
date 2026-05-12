/**
 * Config-save restart state manager.
 *
 * OpenClaw can be restarted from the viewer because the plugin lives
 * inside the gateway process and launchd brings it back.
 *
 * Hermes is different: the viewer daemon is intentionally long-lived,
 * so restart means "terminate the active `hermes chat` process" while
 * keeping this Memory Viewer online. The user can relaunch Hermes and
 * it will reconnect to the existing viewer service.
 */
import { signal } from "@preact/signals";
import { api } from "../api/client";
import { health } from "./health";

export type RestartPhase =
  | "idle"
  | "restarting"
  | "waitingUp"
  | "restartFailed";

export const restartState = signal<{ phase: RestartPhase; message?: string }>({
  phase: "idle",
});

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
 * Quick health check for destructive clear-data only.
 * Do not use this for Hermes config saves: those must keep the current
 * viewer daemon online and terminate only the active `hermes chat`.
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
 * Config saved. OpenClaw gets an in-place gateway restart. Hermes keeps
 * the viewer online and asks the backend to terminate the active chat
 * process; once that request returns, reload the same viewer page.
 *
 * Do not add a passive "settings saved" toast/card here. The restart
 * affordance is intentionally blocking for both agents so the operator
 * sees Hermes' active chat window being closed before the viewer returns.
 */
export async function triggerRestart(): Promise<void> {
  restartState.value = { phase: "restarting" };
  if (!isOpenClaw()) {
    try {
      await api.post("/api/v1/admin/restart");
      await new Promise((r) => setTimeout(r, 500));
      window.location.href =
        window.location.pathname + "?_t=" + Date.now();
    } catch {
      restartState.value = { phase: "restartFailed" };
    }
    return;
  }

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
