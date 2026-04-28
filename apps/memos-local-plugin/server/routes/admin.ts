/**
 * Admin / lifecycle endpoints.
 *
 *   POST /api/v1/admin/clear-data
 *       Wipe the SQLite DB (file + WAL/SHM sidecars) and exit. The
 *       host (OpenClaw gateway / Hermes Python) doesn't reliably
 *       respawn us in-process, so the next agent boot recreates a
 *       fresh DB. The viewer surfaces a "data cleared, restart agent"
 *       toast so the user knows what to do next.
 *
 *   POST /api/v1/admin/restart
 *       Agent-aware restart. For OpenClaw the plugin lives inside the
 *       gateway process, which is managed by macOS launchd — calling
 *       `process.exit(0)` causes launchd to respawn it automatically.
 *       For Hermes and other hosts, the endpoint is a no-op (the
 *       viewer shows a manual-restart toast instead).
 */
import type { ServerDeps, ServerOptions } from "../types.js";
import type { Routes } from "./registry.js";

export function registerAdminRoutes(routes: Routes, deps: ServerDeps, options: ServerOptions = {}): void {
  routes.set("POST /api/v1/admin/clear-data", async (_ctx) => {
    const dbFile = deps.home?.dbFile;
    if (!dbFile) {
      return { ok: false, error: "database path not configured" };
    }
    const fs = await import("node:fs/promises");
    try {
      await deps.core.shutdown();
    } catch { /* best-effort */ }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { await fs.unlink(dbFile + suffix); } catch { /* may not exist */ }
    }
    setTimeout(() => process.exit(0), 300);
    return { ok: true, restarting: true };
  });

  routes.set("POST /api/v1/admin/restart", async (_ctx) => {
    const agent = options.agent ?? "unknown";
    if (agent === "openclaw") {
      // OpenClaw gateway is managed by launchd — exit and let it respawn.
      setTimeout(() => process.exit(0), 300);
      return { ok: true, restarting: true };
    }
    // Hermes / other hosts: no-op — the viewer shows a manual-restart toast.
    return { ok: true, restarting: false, note: "config persisted; restart the agent process to apply" };
  });
}
