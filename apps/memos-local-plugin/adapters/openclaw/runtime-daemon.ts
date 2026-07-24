/** Dedicated single-owner OpenClaw MemoryCore process. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startSocketServer } from "../../bridge/socket.js";
import { resolveHome } from "../../core/config/index.js";
import { memoryBuffer, rootLogger } from "../../core/logger/index.js";
import { bootstrapMemoryCoreFull } from "../../core/pipeline/index.js";
import { Telemetry } from "../../core/telemetry/index.js";
import { startHttpServer } from "../../server/http.js";
import {
  backgroundDrainExitCode,
  readDrainFailureCheckpoint,
  waitForBackgroundDrain,
  writeDrainFailureCheckpoint,
} from "./runtime-drain.js";
import {
  acquireOpenClawRuntimeLock,
  DuplicateOpenClawRuntimeError,
} from "./runtime-lock.js";
import { connectSharedOpenClawRuntime } from "./runtime-client.js";
import { openClawRuntimeSocketPath } from "./runtime-paths.js";
import { openClawRuntimeHealth } from "./runtime-protocol.js";
import { startOptionalViewer } from "./runtime-viewer.js";

const OPENCLAW_VIEWER_PORT = 18799;
const IDLE_QUIET_MS = 3_000;
const BACKGROUND_POLL_MS = 1_000;
const INITIAL_IDLE_SHUTDOWN_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 2 * 60 * 60_000;

function readPackageVersion(): string {
  const adapterDir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(adapterDir, "..", "..", "..", "package.json"),
    path.resolve(adapterDir, "..", "..", "package.json"),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      /* try next layout */
    }
  }
  return "dev";
}

function viewerStaticRoot(): string | undefined {
  const adapterDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(adapterDir, "..", "..", "..", "viewer", "dist"),
    path.resolve(adapterDir, "..", "..", "viewer", "dist"),
  ].find((candidate) => fs.existsSync(candidate));
}

function pluginRoot(): string | undefined {
  const adapterDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(adapterDir, "..", "..", ".."),
    path.resolve(adapterDir, "..", ".."),
  ].find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
}

function explicitHome(): string | undefined {
  const value = process.argv.find((arg) => arg.startsWith("--home="));
  return value?.slice("--home=".length);
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function drainTimeoutMs(): number {
  const configured = Number(process.env.MEMOS_RUNTIME_DRAIN_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_DRAIN_TIMEOUT_MS;
}

async function main(): Promise<void> {
  const drainOnly = hasArg("--drain");
  const noViewer = hasArg("--no-viewer") || drainOnly;
  const version = readPackageVersion();
  const home = resolveHome("openclaw", explicitHome());
  const log = rootLogger.child({ channel: "adapters.openclaw.daemon" });

  let runtimeLock;
  try {
    runtimeLock = acquireOpenClawRuntimeLock({
      home,
      pluginId: "memos-local-plugin",
      version,
      viewerPort: OPENCLAW_VIEWER_PORT,
    });
  } catch (err) {
    if (err instanceof DuplicateOpenClawRuntimeError) {
      if (drainOnly) {
        // A drain command may race an already-running owner. Join that owner
        // and inspect its durable queues instead of treating election loss as
        // a successful drain.
        const client = await connectSharedOpenClawRuntime(home);
        try {
          const failureBaseline = readDrainFailureCheckpoint(home);
          const result = await waitForBackgroundDrain({
            readHealth: () => client.request("core.health"),
            shouldContinue: () => client.connected,
            failureBaseline,
            pollMs: BACKGROUND_POLL_MS,
            quietMs: IDLE_QUIET_MS,
            timeoutMs: drainTimeoutMs(),
          });
          if (
            result.status === "clean" ||
            result.status === "settled_with_failures"
          ) {
            writeDrainFailureCheckpoint(home, result.failureCheckpoint);
          }
          process.exitCode = backgroundDrainExitCode(result, true);
        } finally {
          client.close();
        }
        return;
      }
      // Concurrent clients may all attempt to spawn a daemon. Losing the
      // election is normal: each client will connect to the winning owner.
      process.exitCode = 0;
      return;
    }
    throw err;
  }

  let boot: Awaited<ReturnType<typeof bootstrapMemoryCoreFull>>;
  try {
    boot = await bootstrapMemoryCoreFull({
      agent: "openclaw",
      namespace: { agentKind: "openclaw", profileId: "main" },
      pkgVersion: version,
      home,
    });
  } catch (err) {
    runtimeLock.release();
    throw err;
  }

  const core = boot.core;
  const socketCore = Object.create(core) as typeof core;
  socketCore.health = async () => ({
    ...(await core.health()),
    runtime: openClawRuntimeHealth(version),
  });
  const telemetry = new Telemetry(
    boot.config.telemetry ?? {},
    home.root,
    version,
    rootLogger.child({ channel: "core.telemetry" }),
    pluginRoot(),
  );
  core.bindTelemetry?.(telemetry);
  telemetry.trackPluginStarted("openclaw");

  let viewer: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  let socketServer: Awaited<ReturnType<typeof startSocketServer>> | null = null;
  let initialIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let hadClient = false;
  let shuttingDown = false;
  let drainGeneration = 0;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    drainGeneration += 1;
    if (initialIdleTimer) clearTimeout(initialIdleTimer);
    log.info("runtime.shutdown", { reason });
    try {
      if (socketServer) await socketServer.close();
    } finally {
      try {
        if (viewer) await viewer.close();
      } finally {
        try {
          await core.shutdown();
        } finally {
          runtimeLock.release();
        }
      }
    }
  };

  const beginIdleDrain = (reason: string) => {
    if (shuttingDown) return;
    const generation = ++drainGeneration;
    const failureBaseline = drainOnly
      ? readDrainFailureCheckpoint(home)
      : undefined;
    log.info("runtime.background_drain.begin", { reason });
    void waitForBackgroundDrain({
      readHealth: () => core.health(),
      shouldContinue: () =>
        !shuttingDown &&
        generation === drainGeneration &&
        (drainOnly || (socketServer?.connectionCount ?? 0) === 0),
      failureBaseline,
      pollMs: BACKGROUND_POLL_MS,
      quietMs: IDLE_QUIET_MS,
      timeoutMs: drainTimeoutMs(),
    })
      .then((result) => {
        if (
          result.status === "cancelled" ||
          shuttingDown ||
          generation !== drainGeneration
        ) {
          return;
        }
        const failed =
          result.status === "settled_with_failures" ||
          result.status === "timed_out";
        const details = {
          reason,
          status: result.status,
          terminalFailures: result.terminalFailures,
        };
        if (failed) {
          log.error("runtime.background_drain.terminal_failures", details);
        } else {
          log.info("runtime.background_drain.clean", details);
        }
        if (
          drainOnly &&
          (result.status === "clean" ||
            result.status === "settled_with_failures")
        ) {
          writeDrainFailureCheckpoint(home, result.failureCheckpoint);
        }
        const exitCode = backgroundDrainExitCode(result, drainOnly);
        void shutdown(`idle_${result.status}:${reason}`).then(() => process.exit(exitCode));
      })
      .catch((err) => {
        if (shuttingDown || generation !== drainGeneration) return;
        log.error("runtime.background_drain.failed", {
          reason,
          err: err instanceof Error ? err.message : String(err),
        });
        if (drainOnly) {
          void shutdown(`drain_failed:${reason}`).then(() => process.exit(1));
        }
      });
  };

  try {
    await core.init();
    socketServer = await startSocketServer({
      core: socketCore,
      socketPath: openClawRuntimeSocketPath(home),
      onConnectionCountChanged(count) {
        if (count > 0) {
          hadClient = true;
          drainGeneration += 1;
          if (initialIdleTimer) clearTimeout(initialIdleTimer);
          initialIdleTimer = null;
          return;
        }
        if (!hadClient || shuttingDown) return;
        beginIdleDrain("clients_disconnected");
      },
    });

    if (!noViewer) {
      viewer = await startOptionalViewer(
        () =>
          startHttpServer(
            {
              core,
              home,
              logTail: () => memoryBuffer().tail({ limit: 200 }),
              telemetry,
            },
            {
              port: OPENCLAW_VIEWER_PORT,
              host: boot.config.viewer.bindHost,
              staticRoot: viewerStaticRoot(),
              agent: "openclaw",
            },
          ),
        () => {
          log.warn("viewer.port_in_use", {
            port: OPENCLAW_VIEWER_PORT,
            message: "shared memory runtime remains available headless",
          });
        },
      );
      if (viewer) {
        log.info("viewer.ready", { url: viewer.url });
      }
    }

    if (drainOnly) {
      beginIdleDrain("drain_only");
    } else {
      initialIdleTimer = setTimeout(() => {
        if (!hadClient) beginIdleDrain("never_connected");
      }, INITIAL_IDLE_SHUTDOWN_MS);
      initialIdleTimer.unref?.();
    }
    process.on("SIGINT", () =>
      void shutdown("SIGINT").then(() => process.exit(0)),
    );
    process.on("SIGTERM", () =>
      void shutdown("SIGTERM").then(() => process.exit(0)),
    );
  } catch (err) {
    await shutdown("startup_failed");
    throw err;
  }
}

void main().catch((err) => {
  process.stderr.write(
    `memos-local OpenClaw runtime daemon failed: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }\n`,
  );
  process.exit(1);
});
