import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { IngestWorker } from "../src/ingest/worker";
import { SqliteStore } from "../src/storage/sqlite";
import type { ConversationMessage, Logger, PluginContext } from "../src/types";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeCtx(tmpDir: string): PluginContext {
  return {
    stateDir: tmpDir,
    workspaceDir: tmpDir,
    config: {
      storage: { dbPath: path.join(tmpDir, "test.db") },
      recall: {
        maxResultsDefault: 6,
        maxResultsMax: 20,
        minScoreDefault: 0.45,
        minScoreFloor: 0.35,
        rrfK: 60,
        mmrLambda: 0.7,
        recencyHalfLifeDays: 14,
      },
    },
    log: noopLog,
  };
}

function makeMessage(id: string, sessionKey = "s1"): ConversationMessage {
  return {
    role: "user",
    content: `message-${id}`,
    timestamp: Date.now(),
    turnId: `turn-${id}`,
    sessionKey,
    owner: "agent:main",
  };
}

describe("IngestWorker lifecycle", () => {
  let tmpDir: string;
  let store: SqliteStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-worker-test-"));
    store = new SqliteStore(path.join(tmpDir, "test.db"), noopLog);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flush should wait for task post-processing to finish", async () => {
    const worker = new IngestWorker(store, { embed: vi.fn(), embedQuery: vi.fn() } as any, makeCtx(tmpDir));
    vi.spyOn(worker as any, "ingestMessage").mockResolvedValue({ action: "stored", summary: "ok" });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.spyOn(worker.getTaskProcessor(), "onChunksIngested").mockImplementation(async () => {
      await gate;
    });

    worker.enqueue([makeMessage("1")]);

    let flushed = false;
    const flushPromise = worker.flush().then(() => {
      flushed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushed).toBe(false);

    release();
    await flushPromise;
    expect(flushed).toBe(true);
  });

  it("flush should not resolve while messages queued during task processing are still pending", async () => {
    const worker = new IngestWorker(store, { embed: vi.fn(), embedQuery: vi.fn() } as any, makeCtx(tmpDir));
    const ingestSpy = vi.spyOn(worker as any, "ingestMessage").mockResolvedValue({ action: "stored", summary: "ok" });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let calls = 0;
    vi.spyOn(worker.getTaskProcessor(), "onChunksIngested").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        worker.enqueue([makeMessage("2")]);
        await gate;
      }
    });

    worker.enqueue([makeMessage("1")]);
    const flushPromise = worker.flush();

    setTimeout(() => release(), 0);
    await flushPromise;

    expect(ingestSpy).toHaveBeenCalledTimes(2);
    expect(calls).toBe(2);
  });
});
