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
 *       For Hermes: spawn a new bridge in --daemon mode, then exit the
 *       current process. The new daemon takes over the viewer port so
 *       the Memory Viewer stays available without user intervention.
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
      setTimeout(() => process.exit(0), 300);
      return { ok: true, restarting: true };
    }
    // Hermes (and others): exit first (releasing the port), then a
    // small wrapper script spawns the new daemon. We use a shell
    // one-liner that sleeps briefly (for port release) then starts
    // the new daemon.
    const nodePath = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { spawn } = await import("node:child_process");
    const thisFile = fileURLToPath(import.meta.url);
    const pluginRoot = nodePath.resolve(nodePath.dirname(thisFile), "../..");
    const tsxBin = nodePath.join(pluginRoot, "node_modules/.bin/tsx");
    const bridgeScript = nodePath.join(pluginRoot, "bridge.cts");

    const cmd = `sleep 1 && "${tsxBin}" "${bridgeScript}" --agent=${agent} --daemon`;
    const child = spawn("bash", ["-c", cmd], {
      detached: true,
      stdio: "ignore",
      cwd: pluginRoot,
    });
    child.unref();
    setTimeout(() => process.exit(0), 200);
    return { ok: true, restarting: true };
  });
}
