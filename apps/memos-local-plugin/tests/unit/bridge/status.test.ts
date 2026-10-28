import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBridgeStatusReader,
  createBridgeStatusWriter,
  type BridgeStatusSnapshot,
} from "../../../bridge/status.js";

const STALE_MS = 20_000;

describe("Hermes bridge status ownership", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function statusFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "memos-bridge-status-"));
    tempDirs.push(dir);
    return join(dir, "bridge-status.json");
  }

  function writeStatus(file: string, status: BridgeStatusSnapshot): void {
    writeFileSync(file, JSON.stringify(status), "utf8");
  }

  it("keeps a fresh stdio heartbeat connected even if process detection misses Hermes", () => {
    const file = statusFile();
    writeStatus(file, {
      status: "connected",
      lastOkAt: 90_000,
      lastErrorAt: null,
      lastError: null,
    });

    const isHermesChatRunning = vi.fn(() => false);
    const reader = createBridgeStatusReader(file, {
      isHermesChatRunning,
      now: () => 100_000,
      staleMs: STALE_MS,
    });

    expect(reader.snapshot()).toEqual({
      status: "connected",
      lastOkAt: 90_000,
      lastErrorAt: null,
      lastError: null,
    });
    expect(isHermesChatRunning).not.toHaveBeenCalled();
  });

  it("reports daemon-only startup as not connected without creating a file", () => {
    const file = statusFile();
    const reader = createBridgeStatusReader(file, {
      isHermesChatRunning: () => false,
      now: () => 100_000,
      staleMs: STALE_MS,
    });

    expect(reader.snapshot()).toEqual({
      status: "disconnected",
      lastOkAt: null,
      lastErrorAt: 100_000,
      lastError: "Hermes chat is not connected",
    });
    expect(() => statSync(file)).toThrow();
  });

  it("normalizes a stale heartbeat to not connected when Hermes is not running", () => {
    const file = statusFile();
    const stale = {
      status: "connected" as const,
      lastOkAt: 1_000,
      lastErrorAt: null,
      lastError: null,
    };
    writeStatus(file, stale);
    const before = statSync(file).mtimeNs;

    const reader = createBridgeStatusReader(file, {
      isHermesChatRunning: () => false,
      now: () => 100_000,
      staleMs: STALE_MS,
    });

    expect(reader.snapshot()).toEqual({
      status: "disconnected",
      lastOkAt: 1_000,
      lastErrorAt: 1_000,
      lastError: "Hermes chat is not connected",
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(stale);
    expect(statSync(file).mtimeNs).toBe(before);
  });

  it("reports reconnecting when Hermes is running but its heartbeat is stale", () => {
    const file = statusFile();
    writeStatus(file, {
      status: "connected",
      lastOkAt: 1_000,
      lastErrorAt: null,
      lastError: null,
    });

    const reader = createBridgeStatusReader(file, {
      isHermesChatRunning: () => true,
      now: () => 100_000,
      staleMs: STALE_MS,
    });

    expect(reader.snapshot()).toEqual({
      status: "reconnecting",
      lastOkAt: 1_000,
      lastErrorAt: 1_000,
      lastError: "Hermes bridge heartbeat is stale",
    });
  });

  it("reports a stable waiting state without creating a file when Hermes is starting", () => {
    const file = statusFile();
    const reader = createBridgeStatusReader(file, {
      isHermesChatRunning: () => true,
      now: () => 100_000,
      staleMs: STALE_MS,
    });

    const expected = {
      status: "reconnecting" as const,
      lastOkAt: null,
      lastErrorAt: 100_000,
      lastError: "Hermes chat is running; waiting for memory bridge",
    };
    expect(reader.snapshot()).toEqual(expected);
    expect(reader.snapshot()).toEqual(expected);
    expect(() => statSync(file)).toThrow();
  });

  it("does not overwrite an explicit stdio disconnect while reporting reconnecting", () => {
    const file = statusFile();
    const disconnected = {
      status: "disconnected" as const,
      lastOkAt: 90_000,
      lastErrorAt: 95_000,
      lastError: "Hermes chat disconnected",
    };
    writeStatus(file, disconnected);
    const before = statSync(file).mtimeNs;
    const reader = createBridgeStatusReader(file, {
      isHermesChatRunning: () => true,
      now: () => 100_000,
      staleMs: STALE_MS,
    });

    expect(reader.snapshot()).toEqual({
      status: "reconnecting",
      lastOkAt: 90_000,
      lastErrorAt: 95_000,
      lastError: "Hermes chat is running; waiting for memory bridge",
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(disconnected);
    expect(statSync(file).mtimeNs).toBe(before);
  });

  it("advances only the stdio writer heartbeat and stops cleanly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const file = statusFile();
    const writer = createBridgeStatusWriter(file, { heartbeatMs: 5_000 });

    writer.markConnected();
    expect(JSON.parse(readFileSync(file, "utf8")).lastOkAt).toBe(1_000);

    const heartbeat = writer.startHeartbeat();
    vi.advanceTimersByTime(5_000);
    expect(JSON.parse(readFileSync(file, "utf8")).lastOkAt).toBe(6_000);

    heartbeat.stop();
    vi.advanceTimersByTime(10_000);
    expect(JSON.parse(readFileSync(file, "utf8")).lastOkAt).toBe(6_000);

    writer.markDisconnected("Hermes chat disconnected");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      status: "disconnected",
      lastOkAt: 6_000,
      lastErrorAt: 16_000,
      lastError: "Hermes chat disconnected",
    });
  });
});
