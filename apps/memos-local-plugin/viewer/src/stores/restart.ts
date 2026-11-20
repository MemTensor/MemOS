/**
 * Config-save restart state manager.
 *
 * Supervised Unix OpenClaw can be restarted from the viewer because the
 * plugin lives inside the gateway process and its supervisor brings it back.
 * Windows OpenClaw returns a manual gateway handoff instead.
 *
 * Hermes has separate chat and viewer bridge processes. Unix can replace
 * both automatically; Windows returns exact manual handoff instructions
 * because no supervisor currently owns the portable viewer daemon.
 * DeepSeek Harness hosts MemOS in-process and currently requires a manual
 * profile restart after configuration changes.
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
  instanceId?: string;
  message?: string;
}

export interface ClearDataResponse extends RestartResponse {
  cleared?: boolean;
  manualCloseRequired?: boolean;
}

export const restartState = signal<{ phase: RestartPhase; message?: string }>({
  phase: "idle",
});

export type RestartAgent = "openclaw" | "hermes" | "deepseek-harness";

let lockedRestartAgent: RestartAgent | null = null;

function agentFromHealth(): RestartAgent {
  if (health.value?.agent === "openclaw") return "openclaw";
  if (health.value?.agent === "deepseek-harness") return "deepseek-harness";
  return "hermes";
}

function lockRestartAgent(): RestartAgent {
  lockedRestartAgent = agentFromHealth();
  return lockedRestartAgent;
}

/** Keep restart copy tied to the initiating agent while health is offline. */
export function resolveRestartAgent(): RestartAgent {
  return lockedRestartAgent ?? agentFromHealth();
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

/** Wait for a different Viewer process, not merely another 200 response. */
async function pollHealthUntilReplaced(
  previousInstanceId: string | undefined,
  maxAttempts = 120,
): Promise<boolean> {
  let observedDown = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, 1_000));
    try {
      const payload = await api.get<{ instanceId?: string }>("/api/v1/health");
      if (
        previousInstanceId &&
        payload.instanceId &&
        payload.instanceId !== previousInstanceId
      ) {
        return true;
      }
      // Compatibility with an older replacement daemon that does not yet
      // expose instanceId: require a witnessed outage before accepting it.
      if (!previousInstanceId && observedDown) return true;
    } catch {
      observedDown = true;
      restartState.value = { phase: "waitingUp" };
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
  const agent = lockRestartAgent();
  restartState.value = { phase: "restarting" };
  if (agent !== "openclaw") {
    try {
      const response = await api.post<RestartResponse>("/api/v1/admin/restart");
      if (response.manualRestartRequired) {
        restartState.value = {
          phase: "manualRestartRequired",
          message: response.message,
        };
        // Hermes on Windows replaces its standalone Viewer daemon, so keep
        // this page open and reconnect to the new process. DSH owns the
        // Viewer in-process; its explicit profile-restart handoff must return
        // immediately instead of polling the still-running current process.
        if (agent === "deepseek-harness") return;
        const replaced = await pollHealthUntilReplaced(response.instanceId);
        if (replaced) {
          window.location.href =
            window.location.pathname + "?_t=" + Date.now();
          return;
        }
        restartState.value = { phase: "restartFailed" };
        throw new Error("restart did not complete");
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

  let response: RestartResponse | undefined;
  try {
    response = await api.post<RestartResponse>("/api/v1/admin/restart");
  } catch {
    // Server might already be going down
  }
  if (response?.manualRestartRequired) {
    restartState.value = {
      phase: "manualRestartRequired",
      message: response.message,
    };
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
}

/** Handle the agent/platform-specific result of a destructive clear request. */
export async function triggerCleared(response?: ClearDataResponse): Promise<void> {
  if (restartState.value.phase !== "clearing") lockRestartAgent();
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
  if (resolveRestartAgent() === "openclaw") {
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
  lockRestartAgent();
  restartState.value = { phase: "clearing" };
}

/** The connection dropped before the client could confirm the clear result. */
export function markClearResultUnknown(): void {
  restartState.value = { phase: "clearResultUnknown" };
}

/** Dismiss the banner immediately (e.g. user clicked the close button). */
export function dismissRestartBanner(): void {
  lockedRestartAgent = null;
  restartState.value = { phase: "idle" };
}
