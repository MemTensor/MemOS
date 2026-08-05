/**
 * Config-save restart state manager.
 *
 * OpenClaw can be restarted from the viewer because the plugin lives
 * inside the gateway process and launchd brings it back.
 *
 * Hermes has separate chat and viewer bridge processes. The backend
 * terminates the active chat and replaces the viewer daemon so both
 * processes load the saved config.
 */
import { signal } from "@preact/signals";
import { api } from "../api/client";
import { health } from "./health";

export type RestartPhase =
  | "idle"
  | "restarting"
  | "waitingUp"
  | "restartFailed"
  | "manualRestartRequired";

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
 * Config saved. OpenClaw gets an in-place gateway restart. Hermes
 * replaces its viewer daemon and terminates the active chat process.
 *
 * Do not add a passive "settings saved" toast/card here. The restart
 * affordance is intentionally blocking for both agents so the operator
 * sees Hermes' active chat window being closed before the viewer returns.
 */
export async function triggerRestart(): Promise<void> {
  restartState.value = { phase: "restarting" };
  if (!isOpenClaw()) {
    let response: unknown;
    try {
      response = await api.post("/api/v1/admin/restart");
    } catch {
      restartState.value = { phase: "restartFailed" };
      throw new Error("restart failed");
    }

    // Windows portable installs cannot self-restart (see
    // apps/memos-local-plugin/server/routes/admin.ts). The server keeps
    // the daemon alive and returns manualRestartRequired so we can tell
    // the user to restart Hermes themselves instead of endlessly polling
    // a server that never went down.
    if (
      response &&
      typeof response === "object" &&
      "manualRestartRequired" in (response as Record<string, unknown>) &&
      (response as { manualRestartRequired?: unknown }).manualRestartRequired === true
    ) {
      const message =
        typeof (response as { message?: unknown }).message === "string"
          ? ((response as { message: string }).message)
          : undefined;
      restartState.value = { phase: "manualRestartRequired", message };
      return;
    }

    const ok = await pollHealthUntilUp(60);
    if (ok) {
      window.location.href =
        window.location.pathname + "?_t=" + Date.now();
    } else {
      restartState.value = { phase: "restartFailed" };
      throw new Error("restart did not complete");
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
    throw new Error("restart did not complete");
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
