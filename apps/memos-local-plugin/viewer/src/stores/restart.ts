/**
 * Config-save restart state manager.
 *
 * OpenClaw can be restarted from the viewer because the plugin lives
 * inside the gateway process and launchd brings it back.
 *
 * Hermes has separate chat and viewer bridge processes. Unix can replace
 * both automatically; Windows returns exact manual handoff instructions
 * because no supervisor currently owns the portable viewer daemon.
 */
import { signal } from "@preact/signals";
import { api } from "../api/client";
import { health } from "./health";

export type RestartPhase =
  | "idle"
  | "clearing"
  | "restarting"
  | "waitingUp"
  | "manualCloseRequired"
  | "manualRestartRequired"
  | "manualClearRestartRequired"
  | "clearFailed"
  | "clearResultUnknown"
  | "restartFailed";

interface RestartResponse {
  ok: boolean;
  restarting?: boolean;
  manualRestartRequired?: boolean;
  platform?: string;
  message?: string;
}

export interface ClearDataResponse extends RestartResponse {
  cleared?: boolean;
  manualCloseRequired?: boolean;
}

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
    try {
      const response = await api.post<RestartResponse>("/api/v1/admin/restart");
      if (response.manualRestartRequired) {
        restartState.value = {
          phase: "manualRestartRequired",
          message: response.message,
        };
        return;
      }
    } catch {
      restartState.value = { phase: "restartFailed" };
      throw new Error("restart failed");
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

/** Handle the agent/platform-specific result of a destructive clear request. */
export async function triggerCleared(response?: ClearDataResponse): Promise<void> {
  restartState.value = { phase: "restarting" };
  if (response?.manualCloseRequired) {
    restartState.value = { phase: "manualCloseRequired" };
    return;
  }
  if (response && !response.ok) {
    restartState.value = { phase: "clearFailed" };
    return;
  }
  if (response?.manualRestartRequired) {
    restartState.value = { phase: "manualClearRestartRequired" };
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

/** Clear stale manual-close state before issuing another destructive request. */
export function beginClearData(): void {
  restartState.value = { phase: "clearing" };
}

/** The connection dropped before the client could confirm the clear result. */
export function markClearResultUnknown(): void {
  restartState.value = { phase: "clearResultUnknown" };
}

/** Dismiss the banner immediately (e.g. user clicked the close button). */
export function dismissRestartBanner(): void {
  restartState.value = { phase: "idle" };
}
