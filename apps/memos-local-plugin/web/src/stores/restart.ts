/**
 * Lightweight "config saved" banner state.
 *
 * Why this is no longer a real restart coordinator
 * ================================================
 * Earlier versions of this file POSTed `/api/v1/admin/restart`,
 * which made the plugin call `process.exit(0)` on the assumption
 * that the host (OpenClaw gateway / Hermes Python) would respawn
 * the viewer process. That assumption is wrong:
 *
 *   - OpenClaw's plugin runs *inside* the `openclaw-gateway` process,
 *     so `process.exit(0)` kills the whole gateway. macOS launchd
 *     re-bootstraps the LaunchAgent eventually, but easily later
 *     than the 90 s health-poll deadline.
 *   - Hermes' bridge is spawned via Python `subprocess.Popen` on
 *     demand; once the bridge exits, hermes doesn't try to bring it
 *     back until the next `hermes chat` invocation.
 *
 * Result: the overlay almost always ended in
 *   "Restart didn't complete — service didn't come back in time"
 * even though the config patch on disk had succeeded. Confusing.
 *
 * The honest behaviour is much simpler:
 *
 *   1. The PATCH `/api/v1/config` request already wrote the new
 *      values to `~/.<agent>/memos-plugin/config.yaml`.
 *   2. Show a short "Saved — restart <agent> to apply" toast for a
 *      few seconds. No process exit, no polling, no overlay.
 *   3. The user runs `openclaw gateway stop && start` or relaunches
 *      `hermes chat`; the new bridge picks up the YAML on boot.
 */
import { signal } from "@preact/signals";

export type RestartPhase = "idle" | "saved" | "cleared";

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
  /** Kept for back-compat; ignored. */
  kick?: "restart-endpoint" | "skip";
}

/**
 * Show the "config saved, restart agent to apply" banner.
 *
 * Used by Settings → 保存; the upstream `PATCH /api/v1/config` call
 * has already persisted the YAML before we get here.
 */
export async function triggerRestart(
  _opts: TriggerRestartOptions = {},
): Promise<void> {
  restartState.value = { phase: "saved" };
  scheduleDismiss();
}

/**
 * Show the "data cleared, restart agent to start fresh" banner.
 *
 * Used by Settings → 危险区 → 清空所有数据. The server has wiped the
 * SQLite file; the next agent boot will recreate an empty DB.
 */
export function triggerCleared(): void {
  restartState.value = { phase: "cleared" };
  scheduleDismiss();
}

/** Dismiss the banner immediately (e.g. user clicked the close button). */
export function dismissRestartBanner(): void {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  restartState.value = { phase: "idle" };
}
