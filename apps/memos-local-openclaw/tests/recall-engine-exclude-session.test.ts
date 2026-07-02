import { describe, it, expect, vi } from "vitest";
import { RecallEngine } from "../src/recall/engine";
import type { SqliteStore } from "../src/storage/sqlite";
import type { Embedder } from "../src/embedding";
import type { PluginContext } from "../src/types";

const testLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeContext(): PluginContext {
  return {
    stateDir: "/tmp",
    workspaceDir: "/tmp",
    log: testLog,
    config: {
      recall: {
        maxResultsDefault: 6,
        maxResultsMax: 20,
        minScoreDefault: 0.45,
        minScoreFloor: 0.35,
        rrfK: 60,
        mmrLambda: 0.7,
        recencyHalfLifeDays: 14,
        vectorSearchMaxChunks: 0,
      },
    },
  };
}

describe("RecallEngine.search — excludeSessionKey propagation", () => {
  it("forwards excludeSessionKey to ftsSearch, vectorSearch, and patternSearch", async () => {
    const store = {
      ftsSearch: vi.fn(() => []),
      patternSearch: vi.fn(() => []),
      getAllEmbeddings: vi.fn(() => []),
      getRecentEmbeddings: vi.fn(() => []),
      getChunk: vi.fn(() => null),
    } as unknown as SqliteStore;

    const embedder = {
      embedQuery: vi.fn(async () => [0.1, 0.2, 0.3, 0.4]),
    } as unknown as Embedder;

    const engine = new RecallEngine(store, embedder, makeContext());

    await engine.search({ query: "唐波是谁", excludeSessionKey: "sess-current" });

    // FTS got the excludeSessionKey as 4th argument
    expect(store.ftsSearch).toHaveBeenCalled();
    const ftsArgs = (store.ftsSearch as unknown as { mock: { calls: any[][] } }).mock.calls[0];
    expect(ftsArgs[3]).toBe("sess-current");

    // patternSearch received it in the options object
    expect(store.patternSearch).toHaveBeenCalled();
    const patternArgs = (store.patternSearch as unknown as { mock: { calls: any[][] } }).mock.calls[0];
    expect(patternArgs[1].excludeSessionKey).toBe("sess-current");

    // vector path goes through getAllEmbeddings (since vectorSearchMaxChunks=0 in config)
    expect(store.getAllEmbeddings).toHaveBeenCalled();
    const embArgs = (store.getAllEmbeddings as unknown as { mock: { calls: any[][] } }).mock.calls[0];
    expect(embArgs[1]).toBe("sess-current");
  });

  it("does not pass excludeSessionKey when caller omits it", async () => {
    const store = {
      ftsSearch: vi.fn(() => []),
      patternSearch: vi.fn(() => []),
      getAllEmbeddings: vi.fn(() => []),
      getRecentEmbeddings: vi.fn(() => []),
      getChunk: vi.fn(() => null),
    } as unknown as SqliteStore;

    const embedder = {
      embedQuery: vi.fn(async () => [0.1, 0.2, 0.3, 0.4]),
    } as unknown as Embedder;

    const engine = new RecallEngine(store, embedder, makeContext());

    await engine.search({ query: "唐波是谁" });

    const ftsArgs = (store.ftsSearch as unknown as { mock: { calls: any[][] } }).mock.calls[0];
    expect(ftsArgs[3]).toBeUndefined();

    const patternArgs = (store.patternSearch as unknown as { mock: { calls: any[][] } }).mock.calls[0];
    expect(patternArgs[1].excludeSessionKey).toBeUndefined();

    const embArgs = (store.getAllEmbeddings as unknown as { mock: { calls: any[][] } }).mock.calls[0];
    expect(embArgs[1]).toBeUndefined();
  });
});
