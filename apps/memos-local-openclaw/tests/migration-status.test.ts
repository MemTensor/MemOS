import { describe, it, expect } from "vitest";
import {
  applyMigrationItemToState,
  computeMigrationSuccess,
  createInitialMigrationState,
} from "../src/viewer/server";

describe("migration status step failure reporting", () => {
  it("reports success=false when step failures exist even if no fatal errors", () => {
    const state = createInitialMigrationState();

    applyMigrationItemToState(state, {
      status: "stored",
      index: 1,
      total: 2,
      stepFailures: ["embedding"],
    });

    expect(state.errors).toBe(0);
    expect(state.stepFailures.embedding).toBe(1);
    expect(state.success).toBe(false);
    expect(computeMigrationSuccess(state)).toBe(false);
  });

  it("keeps success=true for clean imports and flips to false when dedup/summarization fail", () => {
    const state = createInitialMigrationState();

    applyMigrationItemToState(state, {
      status: "stored",
      index: 1,
      total: 3,
      stepFailures: [],
    });

    expect(state.success).toBe(true);

    applyMigrationItemToState(state, {
      status: "stored",
      index: 2,
      total: 3,
      stepFailures: ["dedup", "summarization"],
    });

    expect(state.stepFailures.dedup).toBe(1);
    expect(state.stepFailures.summarization).toBe(1);
    expect(state.success).toBe(false);
  });

  it("counts explicit item errors and reports failure", () => {
    const state = createInitialMigrationState();

    applyMigrationItemToState(state, {
      status: "error",
      index: 1,
      total: 1,
      stepFailures: [],
    });

    expect(state.errors).toBe(1);
    expect(state.success).toBe(false);
  });
});
