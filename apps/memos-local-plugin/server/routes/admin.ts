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
 *       LEGACY no-op kept for back-compat with older viewer bundles.
 *       Earlier this endpoint called `process.exit(0)` on the
 *       assumption that the host would respawn the plugin process —
 *       but neither OpenClaw nor Hermes does that automatically, so
 *       the viewer just sat in a "waiting for service to come back"
 *       overlay until it timed out. Modern viewers don't call this;
 *       they just rely on `PATCH /api/v1/config` having persisted
 *       the new YAML to disk and prompt the user to restart their
 *       agent process manually. The endpoint still answers OK so
 *       any older bundle in the wild doesn't error out.
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
    // Exit so the next agent boot creates a clean DB. The viewer
    // toast advises the user to restart the agent manually.
    setTimeout(() => process.exit(0), 300);
    return { ok: true, restarting: true };
  });

  routes.set("POST /api/v1/admin/restart", async (_ctx) => {
    // No-op (see header comment). Kept for back-compat — older viewer
    // bundles still POST here after saving config; we just ack.
    return { ok: true, restarting: false, note: "config persisted; restart the agent process to apply" };
  });
}
