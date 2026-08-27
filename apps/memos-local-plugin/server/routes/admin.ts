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
 *       gateway process. Windows Scheduled Tasks do not respawn a process
 *       that exits successfully, so Windows returns a manual handoff while
 *       supervised Unix installs retain the process-exit restart path.
 *       For Hermes on Unix, terminate the active `hermes chat`, then ask the
 *       bridge to shut down gracefully. launchd/systemd owns replacement when
 *       supervised; portable viewers retain the detached fallback. Windows
 *       returns an explicit manual handoff and keeps the responding process
 *       alive so the route cannot self-destruct before a replacement exists.
 *       DeepSeek Harness is in-process: restart is a manual host handoff and
 *       clear-data is disabled while the profile owns the SQLite connection.
 */
import { spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { ServerDeps, ServerOptions } from "../types.js";
import type { Routes } from "./registry.js";

export function registerAdminRoutes(routes: Routes, deps: ServerDeps, options: ServerOptions = {}): void {
  routes.set("POST /api/v1/admin/clear-data", async (ctx) => {
    const dbFile = deps.home?.dbFile;
    if (!dbFile) {
      return { ok: false, error: "database path not configured" };
    }
    const agent = options.agent ?? "unknown";
    if (agent === "deepseek-harness") {
      return {
        ok: false,
        cleared: false,
        restarting: false,
        error:
          "Clear data is disabled while MemOS is running inside DeepSeek Harness. " +
          "Stop the DSH profile before removing its memory database.",
      };
    }
    const platform = options.lifecycle?.platform ?? process.platform;

    if (platform === "win32") {
      if (agent === "hermes") {
        const bridge = deps.bridgeStatus?.();
        if (!bridge || bridge.status !== "disconnected") {
          return {
            ok: false,
            cleared: false,
            restarting: false,
            manualCloseRequired: true,
            platform,
            message: "Close Hermes completely, then retry clearing data.",
          };
        }
      }

      try {
        await deps.core.shutdown();
      } catch (err) {
        scheduleWindowsShutdownAfterResponse(ctx.res, options);
        return {
          ok: false,
          cleared: false,
          restarting: false,
          manualRestartRequired: true,
          platform,
          error: `Memory core did not shut down cleanly: ${errorMessage(err)}`,
          message: manualClearRestartMessage(agent, false),
        };
      }

      const failures = await removeWindowsRuntimeFiles(dbFile, deps.home?.root);
      scheduleWindowsShutdownAfterResponse(ctx.res, options);
      if (failures.length > 0) {
        return {
          ok: false,
          cleared: false,
          restarting: false,
          manualRestartRequired: true,
          platform,
          error: `Could not remove: ${failures.join(", ")}`,
          message: manualClearRestartMessage(agent, false),
        };
      }
      return {
        ok: true,
        cleared: true,
        restarting: false,
        manualRestartRequired: true,
        platform,
        message: manualClearRestartMessage(agent, true),
      };
    }

    let killedHermes = false;
    if (agent === "hermes") {
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
    if (agent !== "openclaw" && !isSupervisorManaged(options)) {
      // Portable Hermes: there is no supervisor to replace this process.
      await spawnReplacementDaemon(agent, deps.home?.root);
    }
    if (agent === "hermes") {
      scheduleHermesShutdown(options, 200);
    } else {
      setTimeout(() => process.exit(0), 200);
    }
    return { ok: true, restarting: true, killedHermes };
  });

  routes.set("POST /api/v1/admin/restart", async (ctx) => {
    const agent = options.agent ?? "unknown";
    if (agent === "openclaw") {
      const platform = options.lifecycle?.platform ?? process.platform;
      if (platform === "win32") {
        return {
          ok: true,
          restarting: false,
          manualRestartRequired: true,
          platform,
          message:
            "Configuration saved. In PowerShell, run openclaw gateway stop, " +
            "then openclaw gateway start.",
        };
      }
      setTimeout(() => process.exit(0), 300);
      return { ok: true, restarting: true };
    }

    if (agent === "hermes") {
      const platform = options.lifecycle?.platform ?? process.platform;
      if (platform === "win32") {
        // Drain SQLite/background work before the process exits. Windows does
        // not deliver POSIX SIGTERM semantics reliably, so do not depend on a
        // signal handler for graceful core shutdown here.
        try {
          await deps.core.shutdown();
        } catch {
          // The process still needs to exit so the next Hermes launch can
          // replace it with a config-fresh Viewer.
        }
        // The browser already has the manual handoff instructions by the time
        // this response flushes. Stop the old Viewer afterwards so starting
        // Hermes creates a genuinely fresh daemon with the saved config.
        scheduleWindowsShutdownAfterResponse(ctx.res, options);
        return {
          ok: true,
          restarting: false,
          manualRestartRequired: true,
          platform,
          instanceId: options.instanceId,
          message:
            "Configuration saved. Fully quit Hermes, then start it again. " +
            "Wait about 20-30 seconds for Hermes itself to finish initializing. " +
            "Keep this page open; " +
            "it will reconnect and refresh automatically when Memory Viewer is ready.",
        };
      }
      const killed = await terminateHermesChat();
      if (!isSupervisorManaged(options)) {
        await spawnReplacementDaemon(agent, deps.home?.root);
      }
      scheduleHermesShutdown(options, 200);
      return { ok: true, restarting: true, killed };
    }

    if (agent === "deepseek-harness") {
      return {
        ok: true,
        restarting: false,
        manualRestartRequired: true,
        message:
          "Configuration saved. Stop and restart the active DeepSeek Harness profile " +
          "to reload MemOS Local.",
      };
    }

    return { ok: false, error: `restart unsupported for agent: ${agent}` };
  });
}

async function removeWindowsRuntimeFiles(dbFile: string, home?: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const failures: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = dbFile + suffix;
    try {
      await fs.unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") failures.push(target);
      continue;
    }
    try {
      await fs.access(target);
      failures.push(target);
    } catch {
      /* absent as required */
    }
  }
  if (home) {
    try {
      await fs.unlink(`${home}/bridge-status.json`);
    } catch {
      /* status is diagnostic only */
    }
  }
  return [...new Set(failures)];
}

function manualClearRestartMessage(agent: string, cleared: boolean): string {
  const subject = agent === "openclaw" ? "OpenClaw" : "Hermes";
  return cleared
    ? `Data cleared. Start ${subject} again to restart Memory Viewer.`
    : `Data was not fully cleared. Start ${subject} again before retrying.`;
}

function scheduleWindowsShutdownAfterResponse(
  res: ServerResponse,
  options: ServerOptions,
): void {
  let scheduled = false;
  const schedule = (delayMs: number): void => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      if (options.lifecycle?.requestShutdown) {
        options.lifecycle.requestShutdown();
        return;
      }
      process.exit(0);
    }, delayMs);
  };

  // Route handlers return their payload to the HTTP dispatcher, so starting
  // the exit timer inside the handler races JSON serialization on Windows.
  // Wait until ServerResponse has flushed the result before handing off.
  res.once("finish", () => schedule(300));
  res.once("close", () => schedule(res.writableFinished ? 300 : 1_000));
  res.once("error", () => schedule(1_000));
  if (res.writableFinished) {
    schedule(300);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

function isSupervisorManaged(options: ServerOptions): boolean {
  return options.lifecycle?.supervised ?? isSupervisorManagedProcess();
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

async function spawnReplacementDaemon(agent: string, home?: string): Promise<void> {
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
    env: home ? { ...process.env, MEMOS_HOME: home } : process.env,
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
