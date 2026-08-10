import fs from "node:fs";
import path from "node:path";

import type { CoreHealth } from "../../agent-contract/memory-core.js";
import type { ResolvedHome } from "../../core/config/index.js";

const CHECKPOINT_FILENAME = "openclaw-drain-failures.json";

export interface BackgroundWorkSummary {
  active: number;
  terminalFailures: number;
}

export interface DrainFailureCheckpoint {
  version: 1 | 2;
  evolutionDeadLetter: number;
  embeddingFailed: number;
  evolutionFailureSequence: number;
  embeddingFailureSequence: number;
}

export interface BackgroundDrainResult {
  status: "clean" | "settled_with_failures" | "cancelled" | "timed_out";
  terminalFailures: number;
  failureCheckpoint: DrainFailureCheckpoint;
}

export function backgroundDrainExitCode(
  result: BackgroundDrainResult,
  drainOnly: boolean,
): number {
  if (!drainOnly) return 0;
  switch (result.status) {
    case "clean":
      return 0;
    case "settled_with_failures":
      return 2;
    case "cancelled":
      return 3;
    case "timed_out":
      return 4;
  }
}

/**
 * Finish a daemon drain without defeating its timeout. A timed-out semantic
 * job may be stuck forever inside an external model call, and the normal
 * MemoryCore shutdown path waits for that same job. In that case the only
 * bounded operation is process termination; SQLite/WAL and job leases make
 * the unfinished work recoverable by the next owner.
 */
export async function finishBackgroundDrain(
  result: BackgroundDrainResult,
  options: {
    drainOnly: boolean;
    shutdown: () => Promise<void>;
    exit: (code: number) => void;
  },
): Promise<void> {
  const exitCode = backgroundDrainExitCode(result, options.drainOnly);
  if (result.status === "timed_out") {
    options.exit(exitCode);
    return;
  }
  await options.shutdown();
  options.exit(exitCode);
}

export function summarizeBackgroundWork(
  health: Pick<CoreHealth, "evolution" | "embeddingRetry">,
  failureBaseline: DrainFailureCheckpoint = emptyFailureCheckpoint(),
): BackgroundWorkSummary {
  const checkpoint = failureCheckpointFromHealth(health);
  const terminalFailures = checkpoint.version === 2
    ? failureBaseline.version === 2
      ? Math.max(
          0,
          checkpoint.evolutionFailureSequence -
            failureBaseline.evolutionFailureSequence,
        ) +
        Math.max(
          0,
          checkpoint.embeddingFailureSequence -
            failureBaseline.embeddingFailureSequence,
        )
      : Math.max(
          checkpoint.evolutionFailureSequence,
          checkpoint.evolutionDeadLetter -
            failureBaseline.evolutionDeadLetter,
        ) +
        Math.max(
          checkpoint.embeddingFailureSequence,
          checkpoint.embeddingFailed - failureBaseline.embeddingFailed,
        )
    : Math.max(
        0,
        checkpoint.evolutionDeadLetter - failureBaseline.evolutionDeadLetter,
      ) +
      Math.max(
        0,
        checkpoint.embeddingFailed - failureBaseline.embeddingFailed,
      );
  return {
    active:
      (health.evolution?.active ?? 0) +
      (health.embeddingRetry?.pending ?? 0) +
      (health.embeddingRetry?.inProgress ?? 0),
    terminalFailures,
  };
}

export function failureCheckpointFromHealth(
  health: Pick<CoreHealth, "evolution" | "embeddingRetry">,
): DrainFailureCheckpoint {
  const hasSequences =
    health.evolution?.failureSequence !== undefined &&
    health.embeddingRetry?.failureSequence !== undefined;
  return {
    version: hasSequences ? 2 : 1,
    evolutionDeadLetter: nonNegativeCount(health.evolution?.deadLetter),
    embeddingFailed: nonNegativeCount(health.embeddingRetry?.failed),
    evolutionFailureSequence: nonNegativeCount(
      health.evolution?.failureSequence,
    ),
    embeddingFailureSequence: nonNegativeCount(
      health.embeddingRetry?.failureSequence,
    ),
  };
}

export function readDrainFailureCheckpoint(
  home: ResolvedHome,
): DrainFailureCheckpoint {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(home.daemonDir, CHECKPOINT_FILENAME), "utf8"),
    ) as Partial<DrainFailureCheckpoint>;
    const version = parsed.version === 2 ? 2 : 1;
    return {
      version,
      evolutionDeadLetter: nonNegativeCount(parsed.evolutionDeadLetter),
      embeddingFailed: nonNegativeCount(parsed.embeddingFailed),
      evolutionFailureSequence: nonNegativeCount(
        parsed.evolutionFailureSequence,
      ),
      embeddingFailureSequence: nonNegativeCount(
        parsed.embeddingFailureSequence,
      ),
    };
  } catch {
    return emptyFailureCheckpoint();
  }
}

export function writeDrainFailureCheckpoint(
  home: ResolvedHome,
  checkpoint: DrainFailureCheckpoint,
): void {
  fs.mkdirSync(home.daemonDir, { recursive: true });
  fs.writeFileSync(
    path.join(home.daemonDir, CHECKPOINT_FILENAME),
    JSON.stringify(checkpoint),
    { encoding: "utf8", mode: 0o600 },
  );
}

export async function waitForBackgroundDrain(options: {
  readHealth: () => Promise<CoreHealth>;
  shouldContinue: () => boolean;
  failureBaseline?: DrainFailureCheckpoint;
  pollMs?: number;
  quietMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BackgroundDrainResult> {
  const pollMs = options.pollMs ?? 1_000;
  const quietMs = options.quietMs ?? 3_000;
  const timeoutMs = options.timeoutMs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const failureBaseline = options.failureBaseline ?? emptyFailureCheckpoint();
  const startedAt = now();
  let terminalFailures = 0;
  let failureCheckpoint = failureBaseline;

  while (options.shouldContinue()) {
    if (
      timeoutMs !== undefined &&
      timeoutMs >= 0 &&
      now() - startedAt >= timeoutMs
    ) {
      return {
        status: "timed_out",
        terminalFailures,
        failureCheckpoint,
      };
    }
    const health = await options.readHealth();
    failureCheckpoint = failureCheckpointFromHealth(health);
    const state = summarizeBackgroundWork(health, failureBaseline);
    terminalFailures = state.terminalFailures;
    if (state.active > 0) {
      await sleep(pollMs);
      continue;
    }

    // Completing evolution can enqueue embedding compensation work. Require a
    // quiet interval before declaring the shared owner safe to stop.
    await sleep(quietMs);
    if (!options.shouldContinue()) break;
    if (
      timeoutMs !== undefined &&
      timeoutMs >= 0 &&
      now() - startedAt >= timeoutMs
    ) {
      return {
        status: "timed_out",
        terminalFailures,
        failureCheckpoint,
      };
    }
    const stableHealth = await options.readHealth();
    failureCheckpoint = failureCheckpointFromHealth(stableHealth);
    const stable = summarizeBackgroundWork(stableHealth, failureBaseline);
    terminalFailures = stable.terminalFailures;
    if (stable.active === 0) {
      return {
        status: terminalFailures > 0 ? "settled_with_failures" : "clean",
        terminalFailures,
        failureCheckpoint,
      };
    }
  }

  return {
    status: "cancelled",
    terminalFailures,
    failureCheckpoint,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyFailureCheckpoint(): DrainFailureCheckpoint {
  return {
    version: 1,
    evolutionDeadLetter: 0,
    embeddingFailed: 0,
    evolutionFailureSequence: 0,
    embeddingFailureSequence: 0,
  };
}

function nonNegativeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}
