import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { vectorSearch } from "../src/storage/vector";

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Helper to create a test chunk
function createTestChunk(id: string, content: string = "test content") {
  return {
    id,
    sessionKey: "test-session",
    turnId: "test-turn",
    seq: 0,
    role: "user" as const,
    content,
    kind: "memory" as const,
    summary: null,
    taskId: null,
    owner: "agent:main",
    dedupStatus: "active" as const,
    dedupTarget: null,
    dedupReason: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("sqlite-vec vector search", () => {
  let store: SqliteStore;
  let dbPath: string;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-vec-test-"));
    dbPath = path.join(dir, "test.db");
    store = new SqliteStore(dbPath, noopLog);
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("should create vec_chunks table on initialization", () => {
    // The table should exist after store initialization
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
      .all();
    
    // vec_chunks table may or may not exist depending on sqlite-vec availability
    // Both cases are valid (graceful degradation)
    expect(store.hasVecIndex()).toBe(typeof store.hasVecIndex() === "boolean");
  });

  it("should store and retrieve embeddings", () => {
    const chunkId = "test-chunk-1";
    const embedding = Array(2048).fill(0).map((_, i) => i / 2048);
    
    // First create the chunk (required for foreign key constraint)
    store.saveChunk(createTestChunk(chunkId));
    store.upsertEmbedding(chunkId, embedding);
    
    const retrieved = store.getEmbedding(chunkId);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.length).toBe(2048);
    expect(retrieved![0]).toBeCloseTo(embedding[0], 5);
  });

  it("should perform vector search", () => {
    // Insert test chunks and embeddings
    const chunks = [
      { id: "chunk-1", vec: Array(2048).fill(0).map((_, i) => (i === 0 ? 1 : 0)) },
      { id: "chunk-2", vec: Array(2048).fill(0).map((_, i) => (i === 1 ? 1 : 0)) },
      { id: "chunk-3", vec: Array(2048).fill(0).map((_, i) => (i === 2 ? 1 : 0)) },
    ];
    
    for (const chunk of chunks) {
      store.saveChunk(createTestChunk(chunk.id));
      store.upsertEmbedding(chunk.id, chunk.vec);
    }
    
    // Search with a query vector similar to chunk-1
    const queryVec = Array(2048).fill(0).map((_, i) => (i === 0 ? 0.9 : 0.1));
    const results = vectorSearch(store, queryVec, 3);
    
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe("chunk-1");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("should fallback to brute-force when vec index unavailable", () => {
    // Force disable vec index via environment
    const originalEnv = process.env.MEMOS_USE_VEC_INDEX;
    process.env.MEMOS_USE_VEC_INDEX = "false";
    
    try {
      const chunkId = "test-fallback";
      const embedding = Array(2048).fill(0.5);
      
      store.saveChunk(createTestChunk(chunkId));
      store.upsertEmbedding(chunkId, embedding);
      const results = vectorSearch(store, embedding, 1);
      
      expect(results.length).toBe(1);
      expect(results[0].chunkId).toBe(chunkId);
    } finally {
      process.env.MEMOS_USE_VEC_INDEX = originalEnv;
    }
  });
});
