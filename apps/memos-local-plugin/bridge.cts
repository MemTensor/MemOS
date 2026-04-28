/**
 * Bridge entry point (CommonJS).
 *
 * Started by non-TypeScript hosts (e.g. the Hermes Python client) via:
 *
 *   node_modules/.bin/tsx bridge.cts --agent=hermes
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

interface BridgeArgs {
  daemon: boolean;
  tcpPort?: number;
  agent: "openclaw" | "hermes";
}

function parseArgs(argv: readonly string[]): BridgeArgs {
  const args: BridgeArgs = { daemon: false, agent: "openclaw" };
  for (const raw of argv) {
    if (raw === "--daemon") args.daemon = true;
    else if (raw.startsWith("--tcp=")) args.tcpPort = Number(raw.slice(6));
    else if (raw === "--agent=hermes") args.agent = "hermes";
    else if (raw === "--agent=openclaw") args.agent = "openclaw";
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Lazy-import ESM core. Using dynamic import so this file remains
  // CommonJS and stays `require`-able.
  const { bootstrapMemoryCoreFull } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "core/pipeline/index.ts"))
  )) as typeof import("./core/pipeline/index.js");
  const { startStdioServer, waitForShutdown } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "bridge/stdio.ts"))
  )) as typeof import("./bridge/stdio.js");
  const { memoryBuffer } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "core/logger/index.ts"))
  )) as typeof import("./core/logger/index.js");
  const { startHttpServer } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "server/http.ts"))
  )) as typeof import("./server/http.js");

  const pkgVersion = require("./package.json").version;
  const { core, config, home } = await bootstrapMemoryCoreFull({
    agent: args.agent,
    pkgVersion,
  });
  await core.init();

  // Per-agent fixed viewer port.
  const AGENT_DEFAULT_PORTS = { openclaw: 18799, hermes: 18800 } as const;
  const viewerPort = AGENT_DEFAULT_PORTS[args.agent];

  // ─── Daemon mode ──────────────────────────────────────────────
  // When started with `--daemon`, skip stdio and run as a pure HTTP
  // viewer daemon. Used by install.sh (post-install) and admin/restart
  // (self-restart) to keep the Memory Viewer always available.
  if (args.daemon) {
    let viewer: import("./server/types.js").ServerHandle | null = null;
    try {
      viewer = await startHttpServer(
        {
          core,
          home,
          logTail: () => memoryBuffer().tail({ limit: 200 }),
        },
        {
          port: viewerPort,
          host: config.viewer.bindHost,
          staticRoot: path.resolve(__dirname, "web/dist"),
          agent: args.agent,
          daemon: true,
        },
      );
      process.stderr.write(
        `bridge: daemon viewer live at ${viewer.url} (agent=${args.agent})\n`,
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "EADDRINUSE") {
        process.stderr.write(
          `bridge: daemon port :${viewerPort} already in use — exiting.\n`,
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

    const shutdownDaemon = async (sig: string) => {
      process.stderr.write(`bridge: daemon received ${sig}, shutting down\n`);
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
  const stdio = startStdioServer({ core });

  // Try to bind the viewer port. EADDRINUSE → stay headless.
  let viewer: import("./server/types.js").ServerHandle | null = null;
  try {
    viewer = await startHttpServer(
      {
        core,
        home,
        logTail: () => memoryBuffer().tail({ limit: 200 }),
      },
      {
        port: viewerPort,
        host: config.viewer.bindHost,
        staticRoot: path.resolve(__dirname, "web/dist"),
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

  const shutdown = async (sig: string) => {
    process.stderr.write(`bridge: received ${sig}, shutting down\n`);
    if (viewer) {
      try {
        await viewer.close();
      } catch {
        /* best-effort */
      }
    }
    await waitForShutdown(core, stdio);
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
        void core.shutdown().then(() => process.exit(0));
      }
    }, 5_000);
    (keepalive as unknown as { unref?: () => void }).unref?.();
    return;
  }

  // No viewer (headless bridge) — clean exit.
  await core.shutdown();
  process.exit(0);
}

function pathToEsmUrl(abs: string): string {
  const u = abs.startsWith("/") ? `file://${abs}` : `file:///${abs}`;
  return u;
}

void main().catch((err) => {
  process.stderr.write(
    `bridge: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
