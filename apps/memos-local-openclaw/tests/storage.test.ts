import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SqliteStore } from "../src/storage/sqlite";
import { cosineSimilarity, vectorSearch } from "../src/storage/vector";
import type { Chunk, Logger } from "../src/types";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let store: SqliteStore;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-test-"));
  store = new SqliteStore(path.join(tmpDir, "test.db"), noopLog);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: overrides.id ?? "chunk-1",
    sessionKey: "session-1",
    turnId: "turn-1",
    seq: 0,
    role: "user",
    content: "Hello world",
    kind: "paragraph",
    summary: "Greeting message",
    embedding: null,
    taskId: null,
    skillId: null,
    owner: "agent:main",
    dedupStatus: "active",
    dedupTarget: null,
    dedupReason: null,
    mergeCount: 0,
    lastHitAt: null,
    mergeHistory: "[]",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("SqliteStore", () => {
  it("should insert and retrieve a chunk", () => {
    const chunk = makeChunk();
    store.insertChunk(chunk);

    const retrieved = store.getChunk("chunk-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Hello world");
    expect(retrieved!.summary).toBe("Greeting message");
  });

  it("should update summary", () => {
    store.insertChunk(makeChunk());
    store.updateSummary("chunk-1", "Updated summary");

    const retrieved = store.getChunk("chunk-1");
    expect(retrieved!.summary).toBe("Updated summary");
  });

  it("should store and retrieve embeddings", () => {
    store.insertChunk(makeChunk());
    const vec = [0.1, 0.2, 0.3, 0.4, 0.5];
    store.upsertEmbedding("chunk-1", vec);

    const retrieved = store.getEmbedding("chunk-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!).toHaveLength(5);
    expect(retrieved![0]).toBeCloseTo(0.1, 5);
  });

  it("should perform FTS search", () => {
    store.insertChunk(makeChunk({ id: "c1", content: "Deploy the application to production", summary: "Deployment instructions" }));
    store.insertChunk(makeChunk({ id: "c2", content: "The cat sat on the mat", summary: "Cat story" }));

    const results = store.ftsSearch("deploy production", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].chunkId).toBe("c1");
  });

  it("should handle FTS with special characters gracefully", () => {
    store.insertChunk(makeChunk({ id: "c1", content: "Hello world", summary: "test" }));

    const results = store.ftsSearch('hello "world" (test) OR NOT', 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it("should handle FTS query containing date separators", () => {
    store.insertChunk(makeChunk({ id: "c1", content: "release date 2026-03-14", summary: "release note" }));

    const results = store.ftsSearch("2026-03-14", 10);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("should get neighbor chunks", () => {
    const now = Date.now();
    store.insertChunk(makeChunk({ id: "c1", turnId: "t1", seq: 0, createdAt: now }));
    store.insertChunk(makeChunk({ id: "c2", turnId: "t1", seq: 1, createdAt: now + 1 }));
    store.insertChunk(makeChunk({ id: "c3", turnId: "t2", seq: 0, createdAt: now + 2 }));
    store.insertChunk(makeChunk({ id: "c4", turnId: "t2", seq: 1, createdAt: now + 3 }));

    const neighbors = store.getNeighborChunks("session-1", "t1", 1, 2);
    expect(neighbors.length).toBeGreaterThanOrEqual(2);
  });

  it("getRecentEmbeddings returns at most limit rows ordered by created_at DESC", () => {
    const base = Date.now() - 5000;
    for (let i = 0; i < 5; i++) {
      store.insertChunk(makeChunk({ id: `chunk-${i}`, createdAt: base + i * 1000 }));
      store.upsertEmbedding(`chunk-${i}`, [0.1 * (i + 1), 0.2, 0.3]);
    }
    const all = store.getAllEmbeddings();
    expect(all.length).toBe(5);

    const recent2 = store.getRecentEmbeddings(2);
    expect(recent2.length).toBe(2);
    expect(recent2.map((r) => r.chunkId).sort()).toEqual(["chunk-3", "chunk-4"].sort());
  });

  it("getRecentEmbeddings(0) returns all embeddings", () => {
    store.insertChunk(makeChunk({ id: "a", createdAt: Date.now() }));
    store.upsertEmbedding("a", [0.1, 0.2, 0.3]);
    const recent0 = store.getRecentEmbeddings(0);
    expect(recent0.length).toBe(1);
  });
});

describe("vectorSearch", () => {
  const noopLog: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  let store: SqliteStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-vec-"));
    store = new SqliteStore(path.join(tmpDir, "test.db"), noopLog);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("with maxChunks limits search to recent N chunks", () => {
    const base = Date.now() - 5000;
    const dims = 4;
    for (let i = 0; i < 4; i++) {
      store.insertChunk(makeChunk({ id: `c${i}`, createdAt: base + i * 1000 }));
      const vec = new Array(dims).fill(0).map((_, j) => (i === 2 && j === 0 ? 1 : 0.1));
      store.upsertEmbedding(`c${i}`, vec);
    }
    const queryVec = [1, 0, 0, 0];
    const allHits = vectorSearch(store, queryVec, 10);
    expect(allHits.length).toBe(4);

    const cappedHits = vectorSearch(store, queryVec, 10, 2);
    expect(cappedHits.length).toBeLessThanOrEqual(2);
    const cappedIds = new Set(cappedHits.map((h) => h.chunkId));
    expect(cappedIds.size).toBeLessThanOrEqual(2);
  });
});

describe("cosineSimilarity", () => {
  it("should return 1 for identical vectors", () => {
    const v = [0.1, 0.2, 0.3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("should return 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it("should handle zero vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
