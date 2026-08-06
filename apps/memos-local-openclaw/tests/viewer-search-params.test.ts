import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteStore } from "../src/storage/sqlite";
import { ViewerServer } from "../src/viewer/server";

/**
 * Regression coverage for issue #1372 — `/api/search?q=...&limit=...&minScore=...`
 * must respect both query parameters.
 *
 * Before the fix:
 *   - `limit` was never read; merged results were returned in full and the
 *     fallback hard-coded `.slice(0, 20)`.
 *   - `minScore` was never read; the semantic gate was the constant 0.64.
 *
 * After the fix the handler clamps `limit` to [1, 100] (default 20) and
 * `minScore` to [0.35, 1] (default 0.64), echoes both values in the response,
 * and truncates the result set accordingly.
 */

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let tmpDirs: string[] = [];
let stores: SqliteStore[] = [];
let viewer: ViewerServer | null = null;

afterEach(() => {
  viewer?.stop();
  viewer = null;
  for (const store of stores.splice(0)) store.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function viewerAuthCookie(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "passw0rd" }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0];
}

interface SeededChunk {
  id: string;
  content: string;
  vector: number[];
}

/**
 * Embedder stub: returns a fixed query vector and exposes a deterministic
 * embed() for backfill calls (returns the zero vector so it never affects
 * scoring). The real ViewerServer code only calls `embedQuery()` inside
 * `serveSearch`, so this is the only critical knob.
 */
function makeStubEmbedder(queryVector: number[]) {
  const dim = queryVector.length;
  return {
    provider: "local",
    dimensions: dim,
    async embed(texts: string[]) {
      return texts.map(() => new Array(dim).fill(0));
    },
    async embedQuery(_text: string) {
      return queryVector;
    },
  } as any;
}

function seedChunks(store: SqliteStore, chunks: SeededChunk[]) {
  const now = Date.now();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    store.insertChunk({
      id: c.id,
      sessionKey: "session-1372",
      turnId: `turn-${i}`,
      seq: i,
      role: "assistant",
      content: c.content,
      kind: "paragraph",
      summary: c.content,
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
      createdAt: now + i,
      updatedAt: now + i,
    } as any);
    store.upsertEmbedding(c.id, c.vector);
  }
}

function pickPort() {
  return 19400 + Math.floor(Math.random() * 400);
}

describe("ViewerServer /api/search query parameter handling (issue #1372)", () => {
  it("respects ?limit= by truncating the returned result list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-search-limit-"));
    tmpDirs.push(dir);
    const store = new SqliteStore(path.join(dir, "viewer.db"), noopLog as any);
    stores.push(store);

    // Five chunks, all containing the literal "rollout" so FTS will return
    // every row; vector path is disabled by making embedQuery reject below.
    const seeded = Array.from({ length: 5 }, (_, i) => ({
      id: `chunk-rollout-${i}`,
      content: `rollout checklist step ${i + 1}`,
      vector: new Array(8).fill(0),
    }));
    seedChunks(store, seeded);

    const embedder = {
      provider: "local",
      dimensions: 8,
      async embed(texts: string[]) { return texts.map(() => new Array(8).fill(0)); },
      async embedQuery() { throw new Error("vector path disabled for this test"); },
    } as any;

    viewer = new ViewerServer({
      store,
      embedder,
      port: pickPort(),
      log: noopLog as any,
      dataDir: dir,
    });
    const url = await viewer.start();
    const cookie = await viewerAuthCookie(url);

    const limited = await fetch(`${url}/api/search?q=rollout&limit=3`, { headers: { cookie } });
    expect(limited.status).toBe(200);
    const limitedJson = await limited.json();
    expect(limitedJson.results.length).toBe(3);
    expect(limitedJson.total).toBe(3);
    expect(limitedJson.limit).toBe(3);

    const defaultLimit = await fetch(`${url}/api/search?q=rollout`, { headers: { cookie } });
    const defaultJson = await defaultLimit.json();
    expect(defaultJson.limit).toBe(20);
    expect(defaultJson.results.length).toBe(5); // only 5 chunks seeded, all returned within default cap
  });

  it("clamps ?limit= into [1, 100]", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-search-clamp-"));
    tmpDirs.push(dir);
    const store = new SqliteStore(path.join(dir, "viewer.db"), noopLog as any);
    stores.push(store);

    seedChunks(store, [
      { id: "chunk-clamp-1", content: "rollout clamp one", vector: new Array(8).fill(0) },
      { id: "chunk-clamp-2", content: "rollout clamp two", vector: new Array(8).fill(0) },
    ]);

    viewer = new ViewerServer({
      store,
      embedder: {
        provider: "local", dimensions: 8,
        async embed(texts: string[]) { return texts.map(() => new Array(8).fill(0)); },
        async embedQuery() { throw new Error("vector path disabled"); },
      } as any,
      port: pickPort(),
      log: noopLog as any,
      dataDir: dir,
    });
    const url = await viewer.start();
    const cookie = await viewerAuthCookie(url);

    const tooSmall = await (await fetch(`${url}/api/search?q=rollout&limit=0`, { headers: { cookie } })).json();
    expect(tooSmall.limit).toBe(20); // 0 is falsy → falls back to default 20

    const negative = await (await fetch(`${url}/api/search?q=rollout&limit=-5`, { headers: { cookie } })).json();
    expect(negative.limit).toBe(20); // negative → falls back to default 20

    const tooLarge = await (await fetch(`${url}/api/search?q=rollout&limit=9999`, { headers: { cookie } })).json();
    expect(tooLarge.limit).toBe(100);

    const garbage = await (await fetch(`${url}/api/search?q=rollout&limit=NaN`, { headers: { cookie } })).json();
    expect(garbage.limit).toBe(20);
  });

  it("respects ?minScore= by raising the semantic similarity gate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-search-score-"));
    tmpDirs.push(dir);
    const store = new SqliteStore(path.join(dir, "viewer.db"), noopLog as any);
    stores.push(store);

    // Three chunks with engineered vectors so cosine similarity vs the query
    // vector [1,0,0,0] is deterministic:
    //   - high   ≈ 1.00 (passes minScore=0.8)
    //   - medium ≈ 0.70 (passes default 0.64 but fails 0.8)
    //   - low    ≈ 0.40 (fails both)
    // All chunks contain the literal "vector" so FTS also returns them; the
    // test asserts behavior on the merged response.
    seedChunks(store, [
      { id: "chunk-vec-high", content: "vector high similarity", vector: [1, 0, 0, 0] },
      { id: "chunk-vec-med", content: "vector medium similarity", vector: [0.7, Math.sqrt(1 - 0.49), 0, 0] },
      { id: "chunk-vec-low", content: "vector low similarity", vector: [0.4, Math.sqrt(1 - 0.16), 0, 0] },
    ]);

    const embedder = makeStubEmbedder([1, 0, 0, 0]);

    viewer = new ViewerServer({
      store,
      embedder,
      port: pickPort(),
      log: noopLog as any,
      dataDir: dir,
    });
    const url = await viewer.start();
    const cookie = await viewerAuthCookie(url);

    const strict = await (await fetch(`${url}/api/search?q=vector&minScore=0.8&limit=10`, { headers: { cookie } })).json();
    expect(strict.minScore).toBe(0.8);
    // With minScore=0.8 only the high-similarity vector chunk passes the
    // semantic gate; the merged result list therefore starts with it and the
    // FTS-only chunks (medium/low) are appended after — but the issue's
    // contract is that the response should not silently dump every FTS row.
    // Concretely, vectorCount must equal 1.
    expect(strict.vectorCount).toBe(1);

    const lax = await (await fetch(`${url}/api/search?q=vector&minScore=0.64&limit=10`, { headers: { cookie } })).json();
    expect(lax.minScore).toBe(0.64);
    expect(lax.vectorCount).toBeGreaterThanOrEqual(2); // high + medium both clear 0.64
  });

  it("echoes default minScore (0.64) when the param is omitted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-search-default-score-"));
    tmpDirs.push(dir);
    const store = new SqliteStore(path.join(dir, "viewer.db"), noopLog as any);
    stores.push(store);

    seedChunks(store, [
      { id: "chunk-default-1", content: "rollout default one", vector: new Array(8).fill(0) },
    ]);

    viewer = new ViewerServer({
      store,
      embedder: {
        provider: "local", dimensions: 8,
        async embed(texts: string[]) { return texts.map(() => new Array(8).fill(0)); },
        async embedQuery() { throw new Error("vector path disabled"); },
      } as any,
      port: pickPort(),
      log: noopLog as any,
      dataDir: dir,
    });
    const url = await viewer.start();
    const cookie = await viewerAuthCookie(url);

    const resp = await (await fetch(`${url}/api/search?q=rollout`, { headers: { cookie } })).json();
    expect(resp.limit).toBe(20);
    expect(resp.minScore).toBe(0.64);
  });
});
