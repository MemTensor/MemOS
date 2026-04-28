/**
 * Config-save restart state manager.
 *
 * Two distinct flows based on agent type:
 *
 *   - **OpenClaw**: the plugin runs inside the `openclaw-gateway` process
 *     which is managed by macOS launchd. We POST `/api/v1/admin/restart`
 *     to trigger `process.exit(0)`, launchd respawns the gateway, and
 *     we poll `/api/v1/health` until the service comes back, then reload.
 *     During this time a full-screen spinner overlay is shown.
 *
 *   - **Hermes**: the bridge is spawned via Python `subprocess.Popen` on
 *     demand; once it exits, hermes doesn't bring it back until the next
 *     `hermes chat` invocation. So we only show a dismissible toast
 *     telling the user to restart manually.
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

const TOAST_DISMISS_MS = 8_000;

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDismiss(): void {
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = setTimeout(() => {
    restartState.value = { phase: "idle" };
    dismissTimer = null;
  }, TOAST_DISMISS_MS);
}

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
 * Config saved. For OpenClaw: auto-restart with spinner overlay.
 * For Hermes/others: show a dismissible toast.
 */
export async function triggerRestart(
  _opts: TriggerRestartOptions = {},
): Promise<void> {
  if (isOpenClaw()) {
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
  } else {
    restartState.value = { phase: "saved" };
    scheduleDismiss();
  }
}

/**
 * Data cleared. For OpenClaw: auto-restart with spinner.
 * For Hermes/others: show toast.
 */
export async function triggerCleared(): Promise<void> {
  if (isOpenClaw()) {
    restartState.value = { phase: "restarting" };
    const ok = await pollHealthUntilUp(60);
    if (ok) {
      window.location.href =
        window.location.pathname + "?_t=" + Date.now();
    } else {
      restartState.value = { phase: "restartFailed" };
    }
  } else {
    restartState.value = { phase: "cleared" };
    scheduleDismiss();
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
