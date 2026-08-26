import * as fs from "node:fs";
import * as path from "node:path";

export const BRIDGE_STATUS_FILE = "bridge-status.json";
export const BRIDGE_STATUS_HEARTBEAT_MS = 5_000;
export const BRIDGE_STATUS_STALE_MS = 20_000;

export type BridgeStatus =
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "unknown";

export interface BridgeStatusSnapshot {
  status: BridgeStatus;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

export interface BridgeStatusReader {
  snapshot(): BridgeStatusSnapshot;
}

export interface BridgeStatusWriter extends BridgeStatusReader {
  markConnected(): void;
  markDisconnected(message: string): void;
  startHeartbeat(): { stop(): void };
}

interface ReaderOptions {
  isHermesChatRunning: () => boolean;
  now?: () => number;
  staleMs?: number;
}

interface WriterOptions {
  now?: () => number;
  heartbeatMs?: number;
}

function readStatus(statusFile: string): BridgeStatusSnapshot | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(statusFile, "utf8"),
    ) as Partial<BridgeStatusSnapshot>;
    if (
      parsed.status === "connected" ||
      parsed.status === "reconnecting" ||
      parsed.status === "disconnected" ||
      parsed.status === "unknown"
    ) {
      return {
        status: parsed.status,
        lastOkAt:
          typeof parsed.lastOkAt === "number" ? parsed.lastOkAt : null,
        lastErrorAt:
          typeof parsed.lastErrorAt === "number" ? parsed.lastErrorAt : null,
        lastError:
          typeof parsed.lastError === "string" ? parsed.lastError : null,
      };
    }
  } catch {
    // Missing and corrupt status files both mean there is no live writer.
  }
  return null;
}

function errorAt(
  status: BridgeStatusSnapshot | null,
  observedAt: number,
): number {
  return status?.lastErrorAt ?? status?.lastOkAt ?? observedAt;
}

/**
 * Read-only view used by the standalone Hermes Viewer daemon.
 *
 * The nested health `bridge` describes the Python provider ↔ Node stdio
 * transport. The Viewer daemon is a separate HTTP process, so it must never
 * refresh this file or claim that Hermes chat is connected on its own behalf.
 */
export function createBridgeStatusReader(
  statusFile: string,
  options: ReaderOptions,
): BridgeStatusReader {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? BRIDGE_STATUS_STALE_MS;
  const firstObservedAt = now();

  return {
    snapshot() {
      const status = readStatus(statusFile);
      const observedAt = now();
      const freshConnected =
        status?.status === "connected" &&
        status.lastOkAt != null &&
        observedAt - status.lastOkAt <= staleMs;

      // A fresh heartbeat is stronger evidence than process-name probing,
      // which can miss valid Hermes command-line shapes on some platforms.
      if (freshConnected) return { ...status };

      const chatRunning = options.isHermesChatRunning();
      if (chatRunning) {
        const heartbeatStale =
          status?.status === "connected" && status.lastOkAt != null;
        return {
          status: "reconnecting",
          lastOkAt: status?.lastOkAt ?? null,
          lastErrorAt: errorAt(status, firstObservedAt),
          lastError: heartbeatStale
            ? "Hermes bridge heartbeat is stale"
            : "Hermes chat is running; waiting for memory bridge",
        };
      }

      if (status?.status === "disconnected") return { ...status };

      return {
        status: "disconnected",
        lastOkAt: status?.lastOkAt ?? null,
        lastErrorAt: errorAt(status, firstObservedAt),
        lastError: "Hermes chat is not connected",
      };
    },
  };
}

/** The stdio bridge is the sole writer of Hermes transport status. */
export function createBridgeStatusWriter(
  statusFile: string,
  options: WriterOptions = {},
): BridgeStatusWriter {
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? BRIDGE_STATUS_HEARTBEAT_MS;
  let status: BridgeStatusSnapshot = {
    status: "unknown",
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
  };

  function writeStatus(next: BridgeStatusSnapshot): void {
    status = next;
    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(statusFile, JSON.stringify(next), "utf8");
    } catch {
      // Status display must never affect chat capture.
    }
  }

  function markConnected(): void {
    writeStatus({
      status: "connected",
      lastOkAt: now(),
      lastErrorAt: status.lastErrorAt,
      lastError: status.lastError,
    });
  }

  return {
    snapshot() {
      return { ...(readStatus(statusFile) ?? status) };
    },
    markConnected,
    markDisconnected(message: string) {
      writeStatus({
        status: "disconnected",
        lastOkAt: status.lastOkAt,
        lastErrorAt: now(),
        lastError: message,
      });
    },
    startHeartbeat() {
      const timer = setInterval(markConnected, heartbeatMs);
      timer.unref?.();
      return {
        stop() {
          clearInterval(timer);
        },
      };
    },
  };
}
