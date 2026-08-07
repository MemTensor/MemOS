import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SqliteStore } from "../src/storage/sqlite";
import { vectorSearch } from "../src/storage/vector";
import type { Chunk, Logger } from "../src/types";

let store: SqliteStore;
let tmpDir: string;
let warn: ReturnType<typeof vi.fn>;
let originalIndexSetting: string | undefined;

function chunk(id: string, createdAt: number, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id,
    sessionKey: "session-1",
    turnId: "turn-1",
    seq: 0,
    role: "user",
    content: id,
    kind: "paragraph",
    summary: id,
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
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

beforeEach(() => {
  originalIndexSetting = process.env.MEMOS_USE_VEC_INDEX;
  delete process.env.MEMOS_USE_VEC_INDEX;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-sqlite-vec-"));
  warn = vi.fn();
  const log: Logger = { debug: () => {}, info: () => {}, warn, error: () => {} };
  store = new SqliteStore(path.join(tmpDir, "test.db"), log);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalIndexSetting === undefined) delete process.env.MEMOS_USE_VEC_INDEX;
  else process.env.MEMOS_USE_VEC_INDEX = originalIndexSetting;
});

describe("sqlite-vec search", () => {
  it("derives the vec0 dimensions and uses cosine distance", () => {
    expect(store.configureVectorIndex(3)).toBe(true);

    const db = (store as unknown as { db: {
      prepare(sql: string): { get(): { sql: string } };
    } }).db;
    const schema = db.prepare(
      "SELECT sql FROM sqlite_schema WHERE name = 'vec_chunks'",
    ).get().sql;
    expect(schema).toMatch(/FLOAT\s*\[3\]/i);
    expect(schema).toMatch(/distance_metric\s*=\s*cosine/i);
    expect(schema).toMatch(/owner\s+TEXT/i);
    expect(schema).toMatch(/session_key\s+TEXT/i);
  });

  it("returns the same ranking and scores as brute-force cosine search", () => {
    expect(store.configureVectorIndex(3)).toBe(true);
    const now = Date.now();
    const vectors: Array<[string, number[]]> = [
      ["exact", [1, 0, 0]],
      ["near", [0.8, 0.2, 0]],
      ["far", [0, 1, 0]],
    ];
    for (const [id, vector] of vectors) {
      store.insertChunk(chunk(id, now));
      store.upsertEmbedding(id, vector);
    }

    const indexed = vectorSearch(store, [1, 0, 0], 3);
    process.env.MEMOS_USE_VEC_INDEX = "false";
    const bruteForce = vectorSearch(store, [1, 0, 0], 3);

    expect(indexed.map((hit) => hit.chunkId)).toEqual(bruteForce.map((hit) => hit.chunkId));
    indexed.forEach((hit, index) => {
      expect(hit.score).toBeCloseTo(bruteForce[index].score, 5);
    });
  });

  it("backfills matching stored embeddings when the index is created", () => {
    store.insertChunk(chunk("existing", Date.now()));
    store.upsertEmbedding("existing", [1, 0, 0]);

    expect(store.configureVectorIndex(3)).toBe(true);

    expect(store.searchVecChunks([1, 0, 0], 1)).toEqual([
      { chunkId: "existing", distance: 0 },
    ]);
  });

  it("repairs an incomplete existing index on configuration", () => {
    expect(store.configureVectorIndex(3)).toBe(true);
    store.insertChunk(chunk("missing-from-index", Date.now()));
    store.upsertEmbedding("missing-from-index", [1, 0, 0]);
    const db = (store as unknown as { db: {
      prepare(sql: string): { run(...args: unknown[]): unknown };
    } }).db;
    db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?").run("missing-from-index");

    expect(store.configureVectorIndex(3)).toBe(true);

    expect(store.searchVecChunks([1, 0, 0], 1)[0].chunkId).toBe("missing-from-index");
  });

  it("falls back on dimension mismatch", () => {
    expect(store.configureVectorIndex(3)).toBe(true);
    store.insertChunk(chunk("item", Date.now()));
    store.upsertEmbedding("item", [1, 0, 0]);

    const result = vectorSearch(store, [1, 0], 1, undefined, undefined, undefined, {
      debug: () => {}, info: () => {}, warn, error: () => {},
    });

    expect(result).toEqual([{ chunkId: "item", score: 0 }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dimension mismatch"));
  });

  it("applies owner and excluded-session filters inside the index", () => {
    expect(store.configureVectorIndex(3)).toBe(true);
    const indexedSearch = vi.spyOn(store, "searchVecChunks");
    const now = Date.now();
    store.insertChunk(chunk("current-private", now, {
      owner: "agent:alpha",
      sessionKey: "current-session",
    }));
    store.upsertEmbedding("current-private", [1, 0, 0]);
    store.insertChunk(chunk("public-history", now, {
      owner: "public",
      sessionKey: "old-session",
    }));
    store.upsertEmbedding("public-history", [0.9, 0.1, 0]);
    store.insertChunk(chunk("other-private", now, {
      owner: "agent:beta",
      sessionKey: "old-session",
    }));
    store.upsertEmbedding("other-private", [1, 0, 0]);

    const result = vectorSearch(
      store,
      [1, 0, 0],
      5,
      undefined,
      ["agent:alpha", "public"],
      "current-session",
    );

    expect(indexedSearch).toHaveBeenCalled();
    expect(result.map((hit) => hit.chunkId)).toEqual(["public-history"]);
  });

  it("honors vectorSearchMaxChunks by using the filtered fallback", () => {
    expect(store.configureVectorIndex(3)).toBe(true);
    const indexedSearch = vi.spyOn(store, "searchVecChunks");
    store.insertChunk(chunk("old", 100));
    store.upsertEmbedding("old", [1, 0, 0]);
    store.insertChunk(chunk("recent", 200));
    store.upsertEmbedding("recent", [0, 1, 0]);

    const result = vectorSearch(store, [1, 0, 0], 5, 1);

    expect(indexedSearch).not.toHaveBeenCalled();
    expect(result.map((hit) => hit.chunkId)).toEqual(["recent"]);
  });
});
