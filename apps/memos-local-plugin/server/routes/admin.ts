/**
 * Admin / lifecycle endpoints — restart + runtime reload.
 *
 *   POST /api/v1/admin/restart
 *       Trigger a viewer restart. We do NOT kill the whole OpenClaw
 *       gateway from here — that would abort the in-flight request.
 *       Instead we schedule `process.exit(0)` on a short timeout
 *       AFTER we flush the response, and rely on OpenClaw's plugin
 *       host to re-spawn the viewer process (it does; that's how
 *       `install.sh` can drop a new tarball without tearing the
 *       gateway down).
 *
 *       In standalone dev mode (`npm run dev`) the process will just
 *       exit; the viewer tab's `waitForHealth` poll will surface the
 *       outage as a toast. Acceptable — dev mode doesn't self-heal.
 */
import type { ServerDeps } from "../types.js";
import type { Routes } from "./registry.js";

export function registerAdminRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("POST /api/v1/admin/clear-data", async (_ctx) => {
    const dbFile = deps.home?.dbFile;
    if (!dbFile) {
      return { ok: false, error: "database path not configured" };
    }
    const fs = await import("node:fs/promises");
    try {
      await deps.core.shutdown();
    } catch { /* best-effort */ }
    // Remove the SQLite DB file and its WAL/SHM sidecars.
    for (const suffix of ["", "-wal", "-shm"]) {
      try { await fs.unlink(dbFile + suffix); } catch { /* may not exist */ }
    }
    // Schedule restart so the plugin re-creates a fresh DB on boot.
    setTimeout(() => process.exit(0), 300);
    return { ok: true, restarting: true };
  });

  routes.set("POST /api/v1/admin/restart", async (ctx) => {
    // Respond first, exit second. We give the TCP layer ~250ms to
    // flush the response, then schedule a graceful shutdown. The HTTP
    // server's keep-alive socket pool is force-closed so the viewer's
    // reconnect loop kicks in immediately.
    //
    // NOTE: We intentionally use `process.exit(0)` rather than
    // `server.close()` because the plugin host relies on the process
    // lifecycle to decide whether to respawn us.
    setTimeout(() => {
      try {
        // Close the HTTP server first so the response flushes, then
        // exit. Wrapped in try/catch because `ctx.res.socket.server`
        // isn't always reachable in every Node environment.
        const srv: { close?: () => void } | undefined = (
          ctx.res.socket as unknown as { server?: { close?: () => void } } | null
        )?.server ?? undefined;
        srv?.close?.();
      } catch {
        /* ignore — we're about to exit anyway */
      }
      // One more tick for close() to drain, then hard-exit.
      setTimeout(() => process.exit(0), 150);
    }, 250);
    return { ok: true, restarting: true };
  });
}
