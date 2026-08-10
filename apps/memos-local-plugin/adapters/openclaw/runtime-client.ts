import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolvedHome } from "../../core/config/index.js";
import {
  connectSocketClient,
  type SocketClient,
} from "../../bridge/socket.js";
import { inspectOpenClawRuntimeLock } from "./runtime-lock.js";
import { openClawRuntimeSocketPath } from "./runtime-paths.js";
import {
  IncompatibleOpenClawRuntimeError,
  RuntimeWriteOutcomeUnknownError,
  assertCompatibleOpenClawRuntime,
  assertCompatibleOpenClawRuntimeOwner,
  isReplaySafeOpenClawRuntimeMethod,
} from "./runtime-protocol.js";

const START_TIMEOUT_MS = 180_000;
const RETRY_INTERVAL_MS = 200;
const SPAWN_RETRY_MS = 1_000;
const CLIENT_PLUGIN_VERSION = readPackageVersion();

export async function connectSharedOpenClawRuntime(
  home: ResolvedHome,
): Promise<SocketClient> {
  let active = await connectRuntimeOnce(home);
  let reconnecting: Promise<SocketClient> | null = null;
  let closed = false;

  const reconnect = async (failed: SocketClient): Promise<SocketClient> => {
    if (closed) throw new Error("MemOS shared runtime client is closed");
    if (active !== failed && active.connected) return active;
    if (!reconnecting) {
      failed.close();
      reconnecting = connectRuntimeOnce(home)
        .then((client) => {
          if (closed) {
            client.close();
            throw new Error("MemOS shared runtime client closed during reconnect");
          }
          active = client;
          return client;
        })
        .finally(() => {
          reconnecting = null;
        });
    }
    return reconnecting;
  };

  return {
    get connected() {
      return !closed && active.connected;
    },
    async request<R = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }) {
      if (closed) throw new Error("MemOS shared runtime client is closed");
      const client = active;
      try {
        return await client.request<R>(method, params, options);
      } catch (err) {
        if (
          isRpcTimeout(err) &&
          !isReplaySafeOpenClawRuntimeMethod(method)
        ) {
          throw new RuntimeWriteOutcomeUnknownError(method, err);
        }
        if (!isTransportFailure(err)) throw err;
        const replacement = reconnect(client);
        if (!isReplaySafeOpenClawRuntimeMethod(method)) {
          void replacement.catch(() => {
            // The original write already reports an unknown outcome. A later
            // request will retry connection and surface any startup failure.
          });
          throw new RuntimeWriteOutcomeUnknownError(method, err);
        }
        return (await replacement).request<R>(method, params, options);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      active.close();
    },
  };
}

async function connectRuntimeOnce(home: ResolvedHome): Promise<SocketClient> {
  const socketPath = openClawRuntimeSocketPath(home);
  const existing = await tryConnect(socketPath, home);
  if (existing) return existing;

  const deadline = Date.now() + START_TIMEOUT_MS;
  let nextSpawnAt = 0;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const at = Date.now();
    if (at >= nextSpawnAt) {
      const owner = inspectOpenClawRuntimeLock(home);
      if (owner.alive) {
        // Pre-shared-runtime owners use the same lock directory but never
        // create a socket. Waiting the full startup timeout cannot help and
        // hides the required upgrade action from the operator.
        assertCompatibleOpenClawRuntimeOwner(owner.owner, {
          expectedPluginVersion: CLIENT_PLUGIN_VERSION,
        });
      } else {
        try {
          await spawnRuntimeDaemon(home);
        } catch (err) {
          lastError = err;
        }
        nextSpawnAt = at + SPAWN_RETRY_MS;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    let candidate: SocketClient | null = null;
    try {
      candidate = await connectSocketClient(socketPath, {
        connectTimeoutMs: 1_000,
        requestTimeoutMs: 180_000,
      });
      await assertExpectedRuntime(candidate, home);
      return candidate;
    } catch (err) {
      candidate?.close();
      if (err instanceof IncompatibleOpenClawRuntimeError) throw err;
      lastError = err;
    }
  }
  throw new Error(
    `MemOS shared OpenClaw runtime did not become ready for ${home.root}: ${
      lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error")
    }`,
  );
}

function isRpcTimeout(err: unknown): boolean {
  return (err as { code?: unknown }).code === "rpc_timeout";
}

function isTransportFailure(err: unknown): boolean {
  const record = err as { code?: unknown; data?: unknown; message?: unknown };
  // Application failures and request timeouts may have executed already.
  // Replaying a write could duplicate capture or feedback.
  if (typeof record.code === "number" || record.data !== undefined) return false;
  const code = typeof record.code === "string" ? record.code : "";
  if (["ECONNRESET", "EPIPE", "ECONNREFUSED", "ENOENT"].includes(code)) return true;
  const message = typeof record.message === "string" ? record.message : String(err);
  return (
    message.includes("runtime socket closed") ||
    message.includes("socket is not connected")
  );
}

async function tryConnect(
  socketPath: string,
  home: ResolvedHome,
): Promise<SocketClient | null> {
  let client: SocketClient | null = null;
  try {
    client = await connectSocketClient(socketPath, {
      connectTimeoutMs: 500,
      requestTimeoutMs: 5_000,
    });
    await assertExpectedRuntime(client, home);
    return client;
  } catch (err) {
    if (client) {
      client.close();
    }
    if (err instanceof IncompatibleOpenClawRuntimeError) throw err;
    return null;
  }
}

async function assertExpectedRuntime(
  client: SocketClient,
  home: ResolvedHome,
): Promise<void> {
  const health = await client.request<{
    ok?: unknown;
    agent?: unknown;
    paths?: { db?: unknown };
    runtime?: unknown;
  }>("core.health", undefined, { timeoutMs: 5_000 });
  if (
    health.ok !== true ||
    health.agent !== "openclaw" ||
    path.resolve(String(health.paths?.db ?? "")) !== path.resolve(home.dbFile)
  ) {
    client?.close();
    throw new Error(
      `MemOS runtime identity mismatch at ${home.root}: ` +
        `agent=${String(health.agent)} db=${String(health.paths?.db)}`,
    );
  }
  try {
    assertCompatibleOpenClawRuntime(health, {
      expectedPluginVersion: CLIENT_PLUGIN_VERSION,
    });
  } catch (err) {
    client.close();
    throw err;
  }
}

async function spawnRuntimeDaemon(home: ResolvedHome): Promise<void> {
  fs.mkdirSync(home.daemonDir, { recursive: true });
  fs.mkdirSync(home.logsDir, { recursive: true });
  const logPath = path.join(home.logsDir, "openclaw-runtime-daemon.log");
  const logFd = fs.openSync(logPath, "a", 0o600);
  const command = resolveDaemonCommand();
  try {
    const child = spawn(command.executable, [...command.args, `--home=${home.root}`], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        MEMOS_HOME: home.root,
        MEMOS_PLUGIN_HOME: process.env.MEMOS_PLUGIN_HOME ?? home.root,
      },
    });
    child.unref();
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    fs.closeSync(logFd);
  }
}

export function resolveDaemonCommand(): { executable: string; args: string[] } {
  const adapterDir = path.dirname(fileURLToPath(import.meta.url));
  const built = path.join(adapterDir, "runtime-daemon.js");
  if (fs.existsSync(built)) {
    return { executable: process.execPath, args: [built] };
  }

  const source = path.join(adapterDir, "runtime-daemon.ts");
  const pluginRoot = path.resolve(adapterDir, "..", "..");
  const tsxCli = path.join(
    pluginRoot,
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  if (fs.existsSync(source) && fs.existsSync(tsxCli)) {
    return { executable: process.execPath, args: [tsxCli, source] };
  }
  throw new Error(`MemOS OpenClaw runtime daemon entry not found under ${adapterDir}`);
}

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
