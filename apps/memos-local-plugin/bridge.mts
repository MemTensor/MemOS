/**
 * Bridge entry point (pure ESM).
 *
 * Started by non-TypeScript hosts (e.g. the Hermes Python client) via:
 *
 *   node dist/bridge.mjs --agent=hermes --no-viewer
 *
 * This file is the pure-ESM successor of `bridge.cts` / `dist/bridge.cjs`
 * — it exists to eliminate the CommonJS → ESM trampoline that became
 * fragile on Node ≥ 22 (issue #1736). The package is `"type": "module"`,
 * so a `.mjs` entry can statically `import` peer modules and use
 * `import.meta.url` for path resolution, with no `new Function()`
 * trampoline and no `require(file://URL)` indirection. The legacy
 * `bridge.cts` is preserved for backwards compatibility; the Python
 * launcher prefers the new entry whenever `dist/bridge.mjs` exists.
 *
 * Viewer lifecycle
 * ================
 * Each agent owns its own HTTP port:
 *
 *   - openclaw → :18799
 *   - hermes   → :18800
 *
 * The viewer port is adapter-owned (OpenClaw 18799, Hermes 18800).
 * We just call `startHttpServer` once;
 * if the port is already in use we surface the EADDRINUSE error to
 * stderr and keep running stdio-RPC headless (capture / retrieval
 * still work). There's no port-sharing or auto-promotion logic —
 * each agent has its own bookmarkable URL.
 */
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { isHermesChatRunning } from "./bridge/hermes-process.js";
import {
  BRIDGE_STATUS_FILE,
  createBridgeStatusReader,
  createBridgeStatusWriter,
} from "./bridge/status.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keep both executable bridge entries within the same process-level budget.
// Core shutdown has its own cooperative recovery cancellation, while this
// outer deadline guarantees a broken provider cannot orphan the bridge.
const SHUTDOWN_TIMEOUT_MS = 20_000;

function withShutdownTimeout(p: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface BridgeArgs {
  daemon: boolean;
  noViewer: boolean;
  tcpPort?: number;
  agent: "openclaw" | "hermes";
  home?: string;
}

function parseArgs(argv: readonly string[]): BridgeArgs {
  const args: BridgeArgs = { daemon: false, noViewer: false, agent: "openclaw" };
  for (const raw of argv) {
    if (raw === "--daemon") args.daemon = true;
    else if (raw === "--no-viewer") args.noViewer = true;
    else if (raw.startsWith("--tcp=")) args.tcpPort = Number(raw.slice(6));
    else if (raw === "--agent=hermes") args.agent = "hermes";
    else if (raw === "--agent=openclaw") args.agent = "openclaw";
    else if (raw.startsWith("--home=")) args.home = raw.slice(7);
  }
  return args;
}

// ─── PID file singleton guard ───────────────────────────────────────────
// Prevents bridge process accumulation: each new bridge that wants to
// own the viewer port kills the previous holder via its PID file.
// `--no-viewer` (headless) bridges skip this PID file entirely — they don't
// need the port and should coexist with the daemon that owns it.

const PID_FILENAME = "bridge.pid";

function pidFilePath(agent: string, explicitHome?: string): string {
  const configuredHome = explicitHome?.trim()
    || process.env.MEMOS_HOME?.trim()
    || (process.env.MEMOS_CONFIG_FILE?.trim()
      ? path.dirname(process.env.MEMOS_CONFIG_FILE.trim())
      : "");
  if (configuredHome) return path.join(path.resolve(configuredHome), "daemon", PID_FILENAME);
  const agentHome = agent === "hermes" ? ".hermes" : ".openclaw";
  return path.join(
    homedir(),
    agentHome,
    "memos-plugin",
    "daemon",
    PID_FILENAME,
  );
}

function readPidFile(pidPath: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid) || pid <= 0) return null;
    process.kill(pid, 0); // throws if not alive
    return pid;
  } catch {
    return null;
  }
}

function writePidFile(pidPath: string): void {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid), "utf8");
}

function removePidFile(pidPath: string): void {
  try {
    const content = fs.readFileSync(pidPath, "utf8").trim();
    if (content === String(process.pid)) fs.unlinkSync(pidPath);
  } catch {
    /* best-effort; another bridge may have overwritten */
  }
}

function killExistingBridge(pidPath: string, timeoutMs = 5000): void {
  const existingPid = readPidFile(pidPath);
  if (existingPid === null || existingPid === process.pid) return;

  process.stderr.write(
    `bridge: killing stale bridge pid=${existingPid} before startup\n`,
  );
  try {
    process.kill(existingPid, "SIGTERM");
  } catch {
    return; // already dead
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(existingPid, 0);
    } catch {
      return; // gone
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  try {
    process.kill(existingPid, "SIGKILL");
  } catch {
    /* already dead */
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ─── Singleton: kill previous bridge that owns the viewer port ───
  const pidPath = pidFilePath(args.agent, args.home);
  const ownsViewerPort = args.daemon || !args.noViewer;
  const removeOwnedPidFile = () => {
    if (ownsViewerPort) removePidFile(pidPath);
  };
  if (ownsViewerPort) {
    killExistingBridge(pidPath);
    writePidFile(pidPath);
  }

  // Lazy-import core modules from the sibling tree. With a pure-ESM
  // entry there's no CJS↔ESM boundary to cross — the specifiers below
  // are plain relative paths that Node's loader resolves directly.
  // tsx rewrites `.js` → `.ts` at runtime when this file is executed
  // from source via `tsx bridge.mts`.
  const { bootstrapMemoryCoreFull } = await import("./core/pipeline/index.js");
  const { startStdioServer, waitForShutdown } = await import("./bridge/stdio.js");
  const { memoryBuffer, rootLogger } = await import("./core/logger/index.js");
  const { startHttpServer } = await import("./server/http.js");

  const rootDir = pluginRoot();
  const pkgVersion = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
  ).version as string;

  // ─── Host LLM bridge (reverse RPC, lazy-bound to stdio) ────────
  // We need to register the bridge BEFORE bootstrap creates the
  // LlmClients (so the very first `shouldFallback()` check sees a
  // non-null bridge), but `stdio` itself doesn't exist until later
  // in this function. The trick: hand a placeholder closure to
  // bootstrap that defers actual stdio access to the time of the
  // first fallback call. In stdio mode we start the server before
  // `core.init()` so startup recovery can also use host fallback.
  //
  // Routing through `bootstrapMemoryCoreFull({ hostLlmBridge })`
  // (instead of having this file call `registerHostLlmBridge`
  // directly) avoids a subtle ESM module-identity issue: the static
  // `import` chain inside `core/llm/client.ts` and the dynamic
  // `await import(...)` here resolve to the same file URL but Node
  // can occasionally treat them as different module instances with
  // independent `currentBridge` slots. Registering inside bootstrap
  // forces both ends to share the same module instance.
  let stdio: import("./bridge/stdio.js").StdioServerHandle | null = null;
  const lazyHostLlmBridge: import("./core/llm/host-bridge.js").HostLlmBridge =
    {
      id: `stdio.host.${args.agent}.v1`,
      async complete(input) {
        if (!stdio) {
          throw new Error(
            "host LLM bridge invoked before stdio server was ready",
          );
        }
        const result = (await stdio.serverRequest(
          "host.llm.complete",
          {
            messages: input.messages,
            model: input.model,
            temperature: input.temperature,
            maxTokens: input.maxTokens,
            timeoutMs: input.timeoutMs,
          },
          { timeoutMs: (input.timeoutMs ?? 60_000) + 5_000 },
        )) as {
          text?: string;
          model?: string;
          usage?: {
            promptTokens?: number;
            completionTokens?: number;
            totalTokens?: number;
          };
          durationMs?: number;
        };
        return {
          text: typeof result?.text === "string" ? result.text : "",
          model:
            typeof result?.model === "string"
              ? result.model
              : input.model ?? "",
          usage: result?.usage,
          durationMs:
            typeof result?.durationMs === "number" ? result.durationMs : 0,
        };
      },
    };

  const { Telemetry } = await import("./core/telemetry/index.js");

  // Resolve home early so we can use resolveHome with explicit defaultHome
  const { resolveHome } = await import("./core/config/paths.js");

  const resolvedHome = args.home
    ? resolveHome(args.agent, args.home)
    : undefined;

  const { core, config, home } = await bootstrapMemoryCoreFull({
    agent: args.agent,
    namespace: { agentKind: args.agent, profileId: "default" },
    autoRecovery: args.agent !== "hermes" || !args.daemon,
    pkgVersion,
    hostLlmBridge: args.daemon ? null : lazyHostLlmBridge,
    home: resolvedHome,
  });

  const telemetry = new Telemetry(
    config.telemetry ?? {},
    home.root,
    pkgVersion,
    rootLogger.child({ channel: "core.telemetry" }),
    rootDir,
  );
  (core as { bindTelemetry?: (t: InstanceType<typeof Telemetry>) => void }).bindTelemetry?.(telemetry);
  telemetry.trackPluginStarted(args.agent);

  const bridgeStatusFile = path.join(home.root, BRIDGE_STATUS_FILE);
  const bridgeStatusWriter =
    args.agent === "hermes" && !args.daemon
      ? createBridgeStatusWriter(bridgeStatusFile)
      : null;
  const bridgeStatus =
    args.agent === "hermes"
      ? bridgeStatusWriter ??
        createBridgeStatusReader(bridgeStatusFile, { isHermesChatRunning })
      : null;

  // Process-level error reporting. Without these handlers a crash in
  // a background task (capture / reward / L2 inducer) silently kills
  // the bridge process and never surfaces in ARMS — making "0
  // plugin_error events" actively misleading. Both handlers are
  // best-effort and re-emit (or `process.exit(1)`) so we don't
  // alter the existing crash semantics, only add observability.
  // Only registered for the dedicated bridge process; the OpenClaw
  // adapter runs inside the host process and must not steal its
  // global error hooks.
  process.on("uncaughtException", (err) => {
    try {
      telemetry.trackError("uncaught_exception", classifyErrorCode(err));
    } catch {
      /* swallow — telemetry must never widen the crash */
    }
    process.stderr.write(
      `bridge: uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    // Mirror Node's default behaviour so existing supervisors that
    // expect non-zero exit on crash keep working.
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    try {
      telemetry.trackError("unhandled_rejection", classifyErrorCode(reason));
    } catch {
      /* swallow — telemetry must never widen the crash */
    }
    process.stderr.write(
      `bridge: unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`,
    );
    // Don't exit: per-promise rejections are usually recoverable
    // (failed flush, dropped SSE client). The default Node 20+
    // behaviour is to exit, but for a long-running bridge that
    // would be too aggressive — surface to telemetry + stderr and
    // continue.
  });

  // Per-agent fixed viewer port.
  const AGENT_DEFAULT_PORTS = { openclaw: 18799, hermes: 18800 } as const;
  const viewerPort = AGENT_DEFAULT_PORTS[args.agent];

  let bridgeHeartbeat:
    | ReturnType<NonNullable<typeof bridgeStatusWriter>["startHeartbeat"]>
    | undefined;

  // In stdio mode the host fallback path is a reverse JSON-RPC request
  // over the same pipe as normal bridge traffic. `core.init()` may
  // recover dirty episodes and run reflection/reward/L2/skill work; if
  // that work hits a broken primary skill-evolver model, the LLM facade
  // can fall back to host before init returns. Start stdio first so that
  // fallback has a transport instead of tripping the lazy bridge guard.
  if (!args.daemon) {
    stdio = startStdioServer({ core });
    bridgeStatusWriter?.markConnected();
    bridgeHeartbeat = bridgeStatusWriter?.startHeartbeat();
    void stdio.done.then(() => {
      bridgeHeartbeat?.stop();
      bridgeStatusWriter?.markDisconnected("Hermes chat disconnected");
    });
  }

  try {
    await core.init();
  } catch (err) {
    bridgeHeartbeat?.stop();
    if (stdio) {
      try {
        await stdio.close();
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }

  // ─── Daemon mode ──────────────────────────────────────────────
  // When started with `--daemon`, skip stdio and run as a pure HTTP
  // viewer daemon. Used by install.sh (post-install) and admin/restart
  // (self-restart) to keep the Memory Viewer always available.
  if (args.daemon) {
    // Daemon mode is the target of `POST /api/v1/admin/restart`,
    // which re-spawns the bridge after a short sleep. On busy
    // machines the previous bridge's listening socket can take a
    // moment longer than expected to release, so we retry the bind
    // a few times before giving up. Without this the user sees
    // "重启超时" in the viewer because the new daemon raced its
    // predecessor and lost.
    let viewer: import("./server/types.js").ServerHandle | null = null;
    const maxBindAttempts = 10;
    for (let attempt = 1; attempt <= maxBindAttempts; attempt++) {
      try {
        viewer = await startHttpServer(
          {
            core,
            home,
            logTail: () => memoryBuffer().tail({ limit: 200 }),
            bridgeStatus: bridgeStatus ? () => bridgeStatus.snapshot() : undefined,
            telemetry,
          },
          {
            port: viewerPort,
            host: config.viewer.bindHost,
            staticRoot: path.resolve(rootDir, "viewer/dist"),
            agent: args.agent,
          },
        );
        process.stderr.write(
          `bridge: daemon viewer live at ${viewer.url} (agent=${args.agent})\n`,
        );
        break;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e?.code === "EADDRINUSE" && attempt < maxBindAttempts) {
          process.stderr.write(
            `bridge: daemon port :${viewerPort} busy (attempt ${attempt}/${maxBindAttempts}), retrying in 1s...\n`,
          );
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (e?.code === "EADDRINUSE") {
          process.stderr.write(
            `bridge: daemon port :${viewerPort} still in use after ${maxBindAttempts}s — exiting.\n`,
          );
          await withShutdownTimeout(core.shutdown());
          process.exit(1);
        }
        process.stderr.write(
          `bridge: daemon viewer failed: ${(err as Error)?.message ?? String(err)}\n`,
        );
        await withShutdownTimeout(core.shutdown());
        process.exit(1);
      }
    }

    const shutdownDaemon = async (sig: string) => {
      process.stderr.write(`bridge: daemon received ${sig}, shutting down\n`);
      removeOwnedPidFile();
      try { await viewer!.close(); } catch { /* best-effort */ }
      try {
        await withShutdownTimeout(core.shutdown());
      } catch {
        // clear-data already shuts the core down before removing SQLite.
        // The signal still has to terminate the daemon so the supervisor
        // can replace it.
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGINT", () => void shutdownDaemon("SIGINT"));
    process.on("SIGTERM", () => void shutdownDaemon("SIGTERM"));
    // Process stays alive via the HTTP server's ref'd socket.
    return;
  }

  // ─── Normal (stdio) mode ──────────────────────────────────────
  // The stdio handle was started before `core.init()` above so host
  // fallback is available during startup recovery.
  const activeStdio = stdio;
  if (!activeStdio) {
    throw new Error("internal bridge error: stdio server was not started");
  }

  // Try to bind the viewer port unless the caller requested a pure stdio
  // bridge. Hermes chat uses --no-viewer; the standalone --daemon process is
  // the single owner of :18800.
  let viewer: import("./server/types.js").ServerHandle | null = null;
  if (args.noViewer) {
    process.stderr.write(
      `bridge: stdio mode running without viewer (agent=${args.agent})\n`,
    );
  } else {
    try {
      viewer = await startHttpServer(
        {
          core,
          home,
          logTail: () => memoryBuffer().tail({ limit: 200 }),
          bridgeStatus: bridgeStatus ? () => bridgeStatus.snapshot() : undefined,
          telemetry,
        },
        {
          port: viewerPort,
          host: config.viewer.bindHost,
          staticRoot: path.resolve(rootDir, "viewer/dist"),
          agent: args.agent,
        },
      );
      process.stderr.write(
        `bridge: viewer live at ${viewer.url} (agent=${args.agent})\n`,
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "EADDRINUSE") {
        process.stderr.write(
          `bridge: viewer port :${viewerPort} is already in use — ` +
            `${args.agent} will run headless (stdio only). ` +
            `Free the port to expose the viewer.\n`,
        );
      } else {
        process.stderr.write(
          `bridge: viewer failed to start: ${e?.message ?? String(err)}\n`,
        );
      }
    }
  }

  const shutdown = async (sig: string) => {
    process.stderr.write(`bridge: received ${sig}, shutting down\n`);
    removeOwnedPidFile();
    if (viewer) {
      try {
        await viewer.close();
      } catch {
        /* best-effort */
      }
    }
    await withShutdownTimeout(waitForShutdown(core, activeStdio));
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the process alive until stdin ends (client disconnects).
  await activeStdio.done;

  // If a viewer is running, keep the process alive as a daemon so the
  // memory panel stays accessible between `hermes chat` sessions.
  if (viewer && !viewer.closed) {
    process.stderr.write(
      `bridge: stdin closed but viewer is still serving at ${viewer.url} — ` +
        `staying alive as daemon. Send SIGTERM to stop.\n`,
    );
    const keepalive = setInterval(() => {
      if (viewer!.closed) {
        clearInterval(keepalive);
        removeOwnedPidFile();
        void withShutdownTimeout(core.shutdown()).then(() => process.exit(0));
      }
    }, 5_000);
    (keepalive as unknown as { unref?: () => void }).unref?.();
    return;
  }

  // No viewer (headless bridge) — clean exit.
  removeOwnedPidFile();
  await withShutdownTimeout(core.shutdown());
  process.exit(0);
}

function pluginRoot(): string {
  // Source entry: <root>/bridge.mts. Built entry: <root>/dist/bridge.mjs.
  if (fs.existsSync(path.join(__dirname, "package.json"))) return __dirname;
  const parent = path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(parent, "package.json"))) return parent;
  return __dirname;
}

/**
 * Best-effort error classification for ARMS `plugin_error.error_type`.
 *
 * Priority order:
 *   1. `MemosError.code` and Node `errno` (`ENOENT`, `EADDRINUSE`, …)
 *      — both surface as a `code` string property.
 *   2. The constructor name when it's something more specific than
 *      the generic `Error` (e.g. `TypeError`, `SyntaxError`).
 *   3. `unknown` as a sentinel.
 *
 * Never returns the message — those can carry user paths or query
 * fragments and would defeat the redaction the rest of the telemetry
 * pipeline guarantees.
 */
function classifyErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  if (err instanceof Error && err.name && err.name !== "Error") {
    return err.name;
  }
  return "unknown";
}

void main().catch((err) => {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(
    `bridge: fatal: ${detail}\n`,
  );
  process.exit(1);
});
