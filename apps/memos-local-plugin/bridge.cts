/**
 * Bridge entry point (CommonJS).
 *
 * Started by non-TypeScript hosts (e.g. the Hermes Python client) via
 * one of:
 *
 *   node --experimental-strip-types bridge.cts                (default: stdio)
 *   node --experimental-strip-types bridge.cts --daemon       (stdio)
 *   node --experimental-strip-types bridge.cts --daemon --tcp=18911
 *
 * The `.cts` extension is intentional: it lets the file be required
 * from CommonJS environments that spawn Node with `require("...")`
 * semantics. Internally we re-export the ESM implementation via
 * `import()`.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path") as typeof import("node:path");
const pkgVersion: string = (require(path.resolve(__dirname, "package.json")) as { version: string }).version;

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
  const { startTcpServer } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "bridge/tcp.ts"))
  )) as typeof import("./bridge/tcp.js");
  const { startHttpServer } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "server/index.ts"))
  )) as typeof import("./server/index.js");
  const { memoryBuffer } = (await import(
    pathToEsmUrl(path.resolve(__dirname, "core/logger/index.ts"))
  )) as typeof import("./core/logger/index.js");

  const { core, config, home } = await bootstrapMemoryCoreFull({
    agent: args.agent,
    pkgVersion,
  });
  await core.init();

  // Default transport: stdio. In daemon mode, also start TCP if a port was given.
  const stdio = startStdioServer({ core });

  let tcpServer: Awaited<ReturnType<typeof startTcpServer>> | null = null;
  if (args.tcpPort !== undefined) {
    try {
      tcpServer = startTcpServer({
        core,
        host: "127.0.0.1",
        port: args.tcpPort,
      });
      process.stderr.write(`bridge: tcp → ${tcpServer.url}\n`);
    } catch (err) {
      process.stderr.write(
        `bridge: tcp server failed to start: ${(err as Error).message}\n`,
      );
    }
  }

  // Boot a viewer too — hermes needs its own HTTP surface for the
  // Memory Viewer, and it discovers the openclaw hub (if any) so
  // both agents are reachable at `127.0.0.1:18799/<agent>/`.
  const viewerStaticRoot = path.resolve(__dirname, "web/dist");
  let viewer: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  try {
    viewer = await startHttpServer(
      {
        core,
        home,
        logTail: () => memoryBuffer().tail({ limit: 200 }),
      },
      {
        port: config.viewer.port,
        host: config.viewer.bindHost,
        staticRoot: viewerStaticRoot,
        agent: args.agent,
      },
    );
    process.stderr.write(`bridge: viewer → ${viewer.url}\n`);
    if (viewer.port !== config.viewer.port) {
      // We bound a fallback port — tell the hub where we live.
      await tryHubRegister({
        hubPort: config.viewer.port,
        selfPort: viewer.port,
        selfAgent: args.agent,
      });
    }
  } catch (err) {
    process.stderr.write(
      `bridge: viewer failed to start: ${(err as Error).message}\n`,
    );
  }

  const shutdown = async (sig: string) => {
    process.stderr.write(`bridge: received ${sig}, shutting down\n`);
    try {
      if (tcpServer) await tcpServer.close();
    } catch {
      /* best-effort */
    }
    try {
      if (viewer) await viewer.close();
    } catch {
      /* best-effort */
    }
    await waitForShutdown(core, stdio);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // In daemon mode, keep alive until TCP server stops (stdin is /dev/null).
  // In stdio mode, run until the calling process closes stdin.
  if (args.daemon && tcpServer) {
    await tcpServer.done;
    await shutdown("daemon_done");
  } else {
    await stdio.done;
    try {
      if (viewer) await viewer.close();
    } catch {
      /* best-effort */
    }
    await core.shutdown();
    process.exit(0);
  }
}

async function tryHubRegister(opts: {
  hubPort: number;
  selfPort: number;
  selfAgent: "openclaw" | "hermes";
}): Promise<void> {
  const body = JSON.stringify({
    agent: opts.selfAgent,
    port: opts.selfPort,
    version: pkgVersion,
  });
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(
        `http://127.0.0.1:${opts.hubPort}/api/v1/hub/register`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );
      if (r.ok) {
        process.stderr.write(
          `bridge: registered with hub @ :${opts.hubPort} as ${opts.selfAgent} (self port ${opts.selfPort})\n`,
        );
        return;
      }
    } catch {
      /* ignore — retry */
    }
    await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
  }
  process.stderr.write(
    `bridge: could not register with hub @ :${opts.hubPort} — /${opts.selfAgent}/ on hub port will not route\n`,
  );
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
