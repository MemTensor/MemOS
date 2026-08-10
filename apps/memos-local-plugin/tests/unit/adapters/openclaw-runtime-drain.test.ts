import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  backgroundDrainExitCode,
  failureCheckpointFromHealth,
  finishBackgroundDrain,
  readDrainFailureCheckpoint,
  summarizeBackgroundWork,
  waitForBackgroundDrain,
} from "../../../adapters/openclaw/runtime-drain.js";
import type { CoreHealth } from "../../../agent-contract/memory-core.js";

function health(active: number, embeddingPending = 0): CoreHealth {
  return {
    ok: true,
    version: "test",
    agent: "openclaw",
    paths: { home: "", db: "", logs: "", skills: "" },
    config: { loaded: true, sources: [] },
    llm: { available: false, provider: null, model: null },
    embedder: { available: false, provider: null, model: null, dim: null },
    skillEvolver: { available: false, provider: null, model: null },
    evolution: {
      active,
      queued: active,
      leased: 0,
      retrying: 0,
      succeeded: 0,
      deadLetter: 0,
      failureSequence: 0,
    },
    embeddingRetry: {
      pending: embeddingPending,
      inProgress: 0,
      failed: 0,
      succeeded: 0,
      failureSequence: 0,
    },
  };
}

describe("OpenClaw runtime background drain", () => {
  it("waits for active evolution and embedding jobs plus a quiet interval", async () => {
    const states = [health(1), health(0, 1), health(0), health(0)];
    const readHealth = vi.fn(async () => states.shift() ?? health(0));
    const sleep = vi.fn(async () => undefined);

    const result = await waitForBackgroundDrain({
      readHealth,
      shouldContinue: () => true,
      pollMs: 10,
      quietMs: 20,
      sleep,
    });

    expect(result.status).toBe("clean");
    expect(result.failureCheckpoint).toEqual({
      version: 2,
      evolutionDeadLetter: 0,
      embeddingFailed: 0,
      evolutionFailureSequence: 0,
      embeddingFailureSequence: 0,
    });
    expect(readHealth).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[10], [10], [20]]);
  });

  it("returns settled_with_failures when only terminal failures remain", async () => {
    const state = health(0);
    state.evolution!.deadLetter = 2;
    state.embeddingRetry!.failed = 3;
    expect(summarizeBackgroundWork(state)).toEqual({
      active: 0,
      terminalFailures: 5,
    });

    const result = await waitForBackgroundDrain({
      readHealth: async () => state,
      shouldContinue: () => true,
      sleep: async () => undefined,
    });

    expect(result.status).toBe("settled_with_failures");
    expect(result.terminalFailures).toBe(5);
    expect(result.failureCheckpoint).toEqual({
      version: 2,
      evolutionDeadLetter: 2,
      embeddingFailed: 3,
      evolutionFailureSequence: 0,
      embeddingFailureSequence: 0,
    });
    expect(backgroundDrainExitCode(result, true)).toBe(2);
    expect(backgroundDrainExitCode(result, false)).toBe(0);
  });

  it("only reports terminal failures added after the previous drain checkpoint", async () => {
    const old = health(0);
    old.evolution!.deadLetter = 2;
    old.embeddingRetry!.failed = 3;
    const current = health(0);
    current.evolution!.deadLetter = 3;
    current.evolution!.failureSequence = 1;
    current.embeddingRetry!.failed = 3;

    const result = await waitForBackgroundDrain({
      readHealth: async () => current,
      shouldContinue: () => true,
      failureBaseline: failureCheckpointFromHealth(old),
      sleep: async () => undefined,
    });

    expect(result.status).toBe("settled_with_failures");
    expect(result.terminalFailures).toBe(1);
  });

  it("detects a new failure even when terminal row counts stay unchanged", () => {
    const old = health(0);
    old.evolution!.deadLetter = 2;
    old.evolution!.failureSequence = 7;
    old.embeddingRetry!.failed = 3;
    old.embeddingRetry!.failureSequence = 11;
    const current = health(0);
    current.evolution!.deadLetter = 2;
    current.evolution!.failureSequence = 8;
    current.embeddingRetry!.failed = 3;
    current.embeddingRetry!.failureSequence = 12;

    expect(
      summarizeBackgroundWork(current, failureCheckpointFromHealth(old)),
    ).toEqual({
      active: 0,
      terminalFailures: 2,
    });
  });

  it("loads a legacy count-only checkpoint without discarding its baseline", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-drain-v1-"));
    try {
      fs.writeFileSync(
        path.join(dir, "openclaw-drain-failures.json"),
        JSON.stringify({ evolutionDeadLetter: 4, embeddingFailed: 5 }),
      );
      expect(readDrainFailureCheckpoint({ daemonDir: dir } as never)).toEqual({
        version: 1,
        evolutionDeadLetter: 4,
        embeddingFailed: 5,
        evolutionFailureSequence: 0,
        embeddingFailureSequence: 0,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns non-zero for cancelled and timed-out drain-only runs", async () => {
    const cancelled = await waitForBackgroundDrain({
      readHealth: async () => health(0),
      shouldContinue: () => false,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(backgroundDrainExitCode(cancelled, true)).toBeGreaterThan(0);

    let clock = 0;
    const timedOut = await waitForBackgroundDrain({
      readHealth: async () => health(1),
      shouldContinue: () => true,
      timeoutMs: 10,
      now: () => clock,
      sleep: async () => {
        clock += 10;
      },
    });
    expect(timedOut.status).toBe("timed_out");
    expect(backgroundDrainExitCode(timedOut, true)).toBeGreaterThan(0);
  });

  it("forces exit after a drain timeout without entering an unbounded core shutdown", async () => {
    const shutdown = vi.fn(async () => {
      await new Promise<void>(() => undefined);
    });
    const exit = vi.fn();
    const result = {
      status: "timed_out",
      terminalFailures: 0,
      failureCheckpoint: failureCheckpointFromHealth(health(1)),
    } as const;

    await finishBackgroundDrain(result, {
      drainOnly: true,
      shutdown,
      exit,
    });

    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(4);
  });
});
