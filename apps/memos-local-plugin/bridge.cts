/**
 * Bridge entry point (CommonJS).
 *
 * Started by non-TypeScript hosts (e.g. the Hermes Python client) via:
 *
 *   node_modules/.bin/tsx bridge.cts --agent=hermes --no-viewer
 *
 * The `.cts` extension is intentional: it lets the file be required
 * from CommonJS environments that spawn Node with `require("...")`
 * semantics. Internally we re-export the ESM implementation via
 * `import()`.
 *
 * Viewer lifecycle
 * ================
 * Each agent owns its own HTTP port:
 *
 *   - openclaw → :18799
 *   - hermes   → :18800
 *
 * The viewer port is read from the agent's `~/.<agent>/memos-plugin/
 * config.yaml::viewer.port`. We just call `startHttpServer` once;
 * if the port is already in use we surface the EADDRINUSE error to
 * stderr and keep running stdio-RPC headless (capture / retrieval
 * still work). There's no port-sharing or auto-promotion logic —
 * each agent has its own bookmarkable URL.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path") as typeof import("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs") as typeof import("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess = require("node:child_process") as typeof import("node:child_process");

const BRIDGE_STATUS_HEARTBEAT_MS = 5_000;
const BRIDGE_STATUS_STALE_MS = 20_000;
const BRIDGE_STATUS_FILE = "bridge-status.json";

interface BridgeArgs {
  daemon: boolean;
  noViewer: boolean;
  tcpPort?: number;
  agent: "openclaw" | "hermes";
}

type BridgeStatus = "connected" | "reconnecting" | "disconnected" | "unknown";

interface BridgeStatusSnapshot {
  status: BridgeStatus;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

function parseArgs(argv: readonly string[]): BridgeArgs {
  const args: BridgeArgs = { daemon: false, noViewer: false, agent: "openclaw" };
  for (const raw of argv) {
    if (raw === "--daemon") args.daemon = true;
    else if (raw === "--no-viewer") args.noViewer = true;
    else if (raw.startsWith("--tcp=")) args.tcpPort = Number(raw.slice(6));
    else if (raw === "--agent=hermes") args.agent = "hermes";
    else if (raw === "--agent=openclaw") args.agent = "openclaw";
  }
  return args;
}

// ─── PID file singleton guard ───────────────────────────────────────────
// Prevents bridge process accumulation: each new bridge that wants to
// own the viewer port kills the previous holder via its PID file.
// `--no-viewer` (headless) bridges skip the kill — they don't need the
// port and should coexist with the daemon that owns it.

const PID_FILENAME = "bridge.pid";

function pidFilePath(agent: string): string {
  const agentHome = agent === "hermes" ? ".hermes" : ".openclaw";
  return path.join(
    process.env.HOME ?? "/tmp",
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
    childProcess.spawnSync("sleep", ["0.5"]);
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
  const pidPath = pidFilePath(args.agent);
  if (!args.noViewer) {
    killExistingBridge(pidPath);
  }
  writePidFile(pidPath);

  // Lazy-import ESM core. Using dynamic import so this file remains
  // CommonJS and stays `require`-able.
  const { bootstrapMemoryCoreFull } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "core/pipeline/index.ts"))
  )) as typeof import("./core/pipeline/index.js");
  const { startStdioServer, waitForShutdown } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "bridge/stdio.ts"))
  )) as typeof import("./bridge/stdio.js");
  const { memoryBuffer, rootLogger } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "core/logger/index.ts"))
  )) as typeof import("./core/logger/index.js");
  const { startHttpServer } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "server/http.ts"))
  )) as typeof import("./server/http.js");

  const pkgVersion = require("./package.json").version;

  // ─── Host LLM bridge (reverse RPC, lazy-bound to stdio) ────────
  // We need to register the bridge BEFORE bootstrap creates the
  // LlmClients (so the very first `shouldFallback()` check sees a
  // non-null bridge), but `stdio` itself doesn't exist until later
  // in this function. The trick: hand a placeholder closure to
  // bootstrap that defers actual stdio access to the time of the
  // first fallback call. By then `stdio` has been assigned.
  //
  // Routing through `bootstrapMemoryCoreFull({ hostLlmBridge })`
  // (instead of having `bridge.cts` call `registerHostLlmBridge`
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

  const { Telemetry } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "core/telemetry/index.ts"))
  )) as typeof import("./core/telemetry/index.js");

  const { core, config, home } = await bootstrapMemoryCoreFull({
    agent: args.agent,
    namespace: { agentKind: args.agent, profileId: "default" },
    pkgVersion,
    hostLlmBridge: args.daemon ? null : lazyHostLlmBridge,
  });

  const bridgeStatus =
    args.agent === "hermes"
      ? createBridgeStatusTracker(
          path.join(home.root, BRIDGE_STATUS_FILE),
          args.daemon,
        )
      : null;
  await core.init();

  const telemetry = new Telemetry(
    config.telemetry ?? {},
    home.root,
    pkgVersion,
    rootLogger.child({ channel: "core.telemetry" }),
    __dirname,
  );
  (core as { bindTelemetry?: (t: InstanceType<typeof Telemetry>) => void }).bindTelemetry?.(telemetry);
  telemetry.trackPluginStarted(args.agent);

  // Process-level error reporting. Without these handlers a crash in
  // a background task (capture / reward / L2 inducer) silently kills
  // the bridge process and never surfaces in ARMS — making "0
  // plugin_error events" actively misleading. Both handlers are
  // best-effort and re-emit (or `process.exit(1)`) so we don't
  // alter the existing crash semantics, only add observability.
  // Only registered for `bridge.cts` (the dedicated process); the
  // OpenClaw adapter runs inside the host process and must not steal
  // its global error hooks.
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
            staticRoot: path.resolve(__dirname, "viewer/dist"),
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
          await core.shutdown();
          process.exit(1);
        }
        process.stderr.write(
          `bridge: daemon viewer failed: ${(err as Error)?.message ?? String(err)}\n`,
        );
        await core.shutdown();
        process.exit(1);
      }
    }

    const shutdownDaemon = async (sig: string) => {
      process.stderr.write(`bridge: daemon received ${sig}, shutting down\n`);
      removePidFile(pidPath);
      try { await viewer!.close(); } catch { /* best-effort */ }
      await core.shutdown();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdownDaemon("SIGINT"));
    process.on("SIGTERM", () => void shutdownDaemon("SIGTERM"));
    // Process stays alive via the HTTP server's ref'd socket.
    return;
  }

  // ─── Normal (stdio) mode ──────────────────────────────────────
  // Assign the stdio handle into the closure variable so the host
  // LLM bridge (registered earlier inside bootstrap) can dispatch
  // reverse-direction requests to the adapter.
  stdio = startStdioServer({ core });
  bridgeStatus?.markConnected();
  const bridgeHeartbeat = bridgeStatus?.startHeartbeat();
  void stdio.done.then(() => {
    bridgeHeartbeat?.stop();
    bridgeStatus?.markDisconnected("Hermes chat disconnected");
  });

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
          staticRoot: path.resolve(__dirname, "viewer/dist"),
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
    removePidFile(pidPath);
    if (viewer) {
      try {
        await viewer.close();
      } catch {
        /* best-effort */
      }
    }
    await waitForShutdown(core, stdio!);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the process alive until stdin ends (client disconnects).
  await stdio.done;

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
        removePidFile(pidPath);
        void core.shutdown().then(() => process.exit(0));
      }
    }, 5_000);
    (keepalive as unknown as { unref?: () => void }).unref?.();
    return;
  }

  // No viewer (headless bridge) — clean exit.
  removePidFile(pidPath);
  await core.shutdown();
  process.exit(0);
}

function pathToEsmUrl(abs: string): string {
  const u = abs.startsWith("/") ? `file://${abs}` : `file:///${abs}`;
  return u;
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

function createBridgeStatusTracker(statusFile: string, daemon: boolean): {
  snapshot(): BridgeStatusSnapshot;
  markConnected(): void;
  markDisconnected(message: string): void;
  startHeartbeat(): { stop(): void };
} {
  let snapshot: BridgeStatusSnapshot = daemon
    ? {
        status: "disconnected",
        lastOkAt: null,
        lastErrorAt: Date.now(),
        lastError: "Hermes chat is not connected",
      }
    : {
        status: "unknown",
        lastOkAt: null,
        lastErrorAt: null,
        lastError: null,
      };

  function writeStatus(next: BridgeStatusSnapshot): void {
    snapshot = next;
    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(statusFile, JSON.stringify(next), "utf8");
    } catch {
      // Status display must never affect chat capture.
    }
  }

  function readStatus(): BridgeStatusSnapshot | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(statusFile, "utf8")) as Partial<BridgeStatusSnapshot>;
      if (
        parsed.status === "connected" ||
        parsed.status === "reconnecting" ||
        parsed.status === "disconnected" ||
        parsed.status === "unknown"
      ) {
        return {
          status: parsed.status,
          lastOkAt: typeof parsed.lastOkAt === "number" ? parsed.lastOkAt : null,
          lastErrorAt: typeof parsed.lastErrorAt === "number" ? parsed.lastErrorAt : null,
          lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
        };
      }
    } catch {
      // Missing or corrupt status files are treated as disconnected.
    }
    return null;
  }

  function applyStaleRule(raw: BridgeStatusSnapshot): BridgeStatusSnapshot {
    if (raw.status === "disconnected" && daemon && isHermesChatRunning()) {
      return {
        status: "reconnecting",
        lastOkAt: raw.lastOkAt,
        lastErrorAt: raw.lastErrorAt,
        lastError: "Hermes chat is running; waiting for memory bridge",
      };
    }
    if (
      raw.status === "connected" &&
      raw.lastOkAt != null &&
      Date.now() - raw.lastOkAt > BRIDGE_STATUS_STALE_MS
    ) {
      return {
        status: "disconnected",
        lastOkAt: raw.lastOkAt,
        lastErrorAt: Date.now(),
        lastError: "Hermes bridge heartbeat is stale",
      };
    }
    return raw;
  }

  function markConnected(): void {
    writeStatus({
      status: "connected",
      lastOkAt: Date.now(),
      lastErrorAt: snapshot.lastErrorAt,
      lastError: snapshot.lastError,
    });
  }

  function markDisconnected(message: string): void {
    writeStatus({
      status: "disconnected",
      lastOkAt: snapshot.lastOkAt,
      lastErrorAt: Date.now(),
      lastError: message,
    });
  }

  return {
    snapshot() {
      return { ...applyStaleRule(readStatus() ?? snapshot) };
    },
    markConnected,
    markDisconnected,
    startHeartbeat() {
      const timer = setInterval(() => {
        markConnected();
      }, BRIDGE_STATUS_HEARTBEAT_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      return {
        stop() {
          clearInterval(timer);
        },
      };
    },
  };
}

function isHermesChatRunning(): boolean {
  try {
    const out = childProcess.execFileSync("pgrep", ["-f", "hermes chat"], {
      encoding: "utf8",
      timeout: 1000,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

void main().catch((err) => {
  process.stderr.write(
    `bridge: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
