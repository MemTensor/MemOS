/**
 * Admin / lifecycle endpoints.
 *
 *   POST /api/v1/admin/clear-data
 *       Wipe the SQLite DB (file + WAL/SHM sidecars) and exit. The
 *       host (OpenClaw gateway / Hermes Python) doesn't reliably
 *       respawn us in-process, so we stop stale host-side writers
 *       before replacing the DB and let the next agent boot recreate
 *       a fresh connection.
 *
 *   POST /api/v1/admin/restart
 *       Agent-aware restart. For OpenClaw the plugin lives inside the
 *       gateway process, which is managed by macOS launchd — calling
 *       `process.exit(0)` causes launchd to respawn it automatically.
 *       For Hermes, terminate the active `hermes chat`, then ask the bridge
 *       to shut down gracefully. launchd/systemd owns replacement when the
 *       viewer is supervised; portable viewers retain the detached fallback.
 *
 *       Windows portable installs are a special case: `pkill` and `bash`
 *       are unavailable, so the historical spawn-then-suicide sequence
 *       would kill this daemon with no replacement waiting. On Windows
 *       (without a detectable supervisor) we refuse the restart, keep
 *       the daemon alive, and return `manualRestartRequired: true` so
 *       the viewer can prompt the operator to restart Hermes themselves.
 */
import { spawn } from "node:child_process";
import type { ServerDeps, ServerOptions } from "../types.js";
import type { Routes } from "./registry.js";

export function registerAdminRoutes(routes: Routes, deps: ServerDeps, options: ServerOptions = {}): void {
  routes.set("POST /api/v1/admin/clear-data", async (_ctx) => {
    const dbFile = deps.home?.dbFile;
    if (!dbFile) {
      return { ok: false, error: "database path not configured" };
    }
    const agent = options.agent ?? "unknown";
    const supervised = isSupervisorManaged(options);
    const platform = resolvePlatform(options);
    // Windows portable install has no pkill/bash equivalent, so we cannot
    // kill the chat or spawn a replacement daemon. Wipe the DB and leave
    // the process alive; the Hermes chat is NOT killed (no pkill available)
    // and the user must restart Hermes manually to obtain a clean state.
    const windowsManual = agent === "hermes" && !supervised && isWindowsPlatform(platform);

    let killedHermes = false;
    if (agent === "hermes" && !windowsManual) {
      // The viewer daemon and an active Hermes chat have separate Node
      // bridges. Kill the chat first so its stdio bridge releases any
      // SQLite handle before we unlink the DB files.
      killedHermes = await terminateHermesChat();
    }
    const fs = await import("node:fs/promises");
    try {
      await deps.core.shutdown();
    } catch { /* best-effort */ }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { await fs.unlink(dbFile + suffix); } catch { /* may not exist */ }
    }
    if (agent === "hermes" && deps.home?.root) {
      try { await fs.unlink(`${deps.home.root}/bridge-status.json`); } catch { /* may not exist */ }
    }
    if (windowsManual) {
      return {
        ok: true,
        restarting: false,
        killedHermes,
        manualRestartRequired: true,
        platform,
        message:
          "Data cleared. Restart Hermes manually to re-open the Memory Viewer.",
      };
    }
    if (agent !== "openclaw" && !supervised) {
      // Portable Hermes: there is no supervisor to replace this process.
      await spawnReplacementDaemon(agent);
    }
    if (agent === "hermes") {
      scheduleHermesShutdown(options, 200);
    } else {
      setTimeout(() => process.exit(0), 200);
    }
    return { ok: true, restarting: true, killedHermes };
  });

  routes.set("POST /api/v1/admin/restart", async (_ctx) => {
    const agent = options.agent ?? "unknown";
    const supervised = isSupervisorManaged(options);
    const platform = resolvePlatform(options);

    if (agent === "openclaw") {
      setTimeout(() => process.exit(0), 300);
      return { ok: true, restarting: true };
    }

    if (agent === "hermes") {
      if (!supervised && isWindowsPlatform(platform)) {
        // Windows without a supervisor: there is no reliable way to
        // spawn a replacement (no pkill, no bash) and self-shutdown
        // would leave the viewer permanently dark. Keep the daemon
        // alive and tell the client to prompt for a manual restart.
        // ok: true mirrors the clear-data Windows path so typed SDK
        // wrappers that treat `ok` as a success discriminant classify
        // this "intentional decline" identically across both routes.
        return {
          ok: true,
          restarting: false,
          manualRestartRequired: true,
          platform,
          message:
            "Restart is unavailable on Windows without a supervisor. " +
            "Close and reopen Hermes to apply changes.",
        };
      }

      const killed = await terminateHermesChat();
      if (!supervised) {
        await spawnReplacementDaemon(agent);
      }
      scheduleHermesShutdown(options, 200);
      return { ok: true, restarting: true, killed };
    }

    return { ok: false, error: `restart unsupported for agent: ${agent}` };
  });
}

/**
 * Detect the supervisors used by supported desktop/server installs.
 *
 * The MemOS launchd job exports its stable label through XPC_SERVICE_NAME.
 * Do not treat arbitrary GUI-app XPC labels as supervision: a portable
 * daemon launched from such an app would exit with nobody to replace it.
 * systemd services expose INVOCATION_ID for the invocation.
 */
export function isSupervisorManagedProcess(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const xpcService = env.XPC_SERVICE_NAME?.trim();
  if (xpcService?.startsWith("ai.memtensor.memos-local-hermes")) return true;
  return Boolean(env.INVOCATION_ID?.trim());
}

/**
 * True when the current (or provided) platform is Windows.
 *
 * Exposed for the admin routes and their tests so we can unit-test the
 * Windows guard without spoofing `process.platform`.
 */
export function isWindowsPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32";
}

function isSupervisorManaged(options: ServerOptions): boolean {
  return options.lifecycle?.supervised ?? isSupervisorManagedProcess();
}

function resolvePlatform(options: ServerOptions): NodeJS.Platform {
  return options.lifecycle?.platform ?? process.platform;
}

function scheduleHermesShutdown(options: ServerOptions, delayMs: number): void {
  setTimeout(() => {
    if (options.lifecycle?.requestShutdown) {
      options.lifecycle.requestShutdown();
      return;
    }
    // The bridge entry owns SIGINT/SIGTERM and drains the HTTP server,
    // MemoryCore, telemetry and SQLite before exiting. Do not call
    // process.exit() here: that bypasses the bridge's graceful path.
    process.kill(process.pid, "SIGTERM");
  }, delayMs);
}

async function spawnReplacementDaemon(agent: string): Promise<void> {
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const thisFile = fileURLToPath(import.meta.url);
  let pluginRoot = nodePath.resolve(nodePath.dirname(thisFile), "../..");
  // Source: <root>/server/routes/admin.ts. Built package:
  // <root>/dist/server/routes/admin.js.
  if (!fs.existsSync(nodePath.join(pluginRoot, "package.json"))) {
    pluginRoot = nodePath.resolve(pluginRoot, "..");
  }
  const tsxBin = nodePath.join(pluginRoot, "node_modules/.bin/tsx");
  const bridgeScript = nodePath.join(pluginRoot, "bridge.cts");
  const cmd = `sleep 3 && "${process.execPath}" "${tsxBin}" "${bridgeScript}" --agent=${agent} --daemon`;
  const child = spawn("bash", ["-c", cmd], {
    detached: true,
    stdio: "ignore",
    cwd: pluginRoot,
  });
  child.unref();
}

async function terminateHermesChat(): Promise<boolean> {
  // Match the Hermes CLI wrapper used by install.sh without touching
  // `bridge.cts --daemon`, which owns the Memory Viewer port.
  const patterns = ["/bin/hermes", "hermes chat"];
  let signalled = false;

  for (const pattern of patterns) {
    const ok = await runQuiet("pkill", ["-TERM", "-f", pattern]);
    signalled ||= ok;
  }

  if (!signalled) return false;
  await new Promise((resolve) => setTimeout(resolve, 1200));

  for (const pattern of patterns) {
    await runQuiet("pkill", ["-KILL", "-f", pattern]);
  }
  return true;
}

function runQuiet(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
