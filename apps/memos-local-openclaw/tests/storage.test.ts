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

describe("SqliteStore hub sharing schema", () => {
  it("should persist a single client hub connection record", () => {
    store.setClientHubConnection({
      hubUrl: "http://127.0.0.1:18800",
      userId: "user-1",
      username: "alice",
      userToken: "token-1",
      role: "admin",
      connectedAt: 123,
    });

    const saved = store.getClientHubConnection();
    expect(saved).toMatchObject({
      hubUrl: "http://127.0.0.1:18800",
      userId: "user-1",
      username: "alice",
      userToken: "token-1",
      role: "admin",
      connectedAt: 123,
    });

    store.setClientHubConnection({
      hubUrl: "http://192.168.1.8:18800",
      userId: "user-2",
      username: "bob",
      userToken: "token-2",
      role: "member",
      connectedAt: 456,
    });

    const updated = store.getClientHubConnection();
    expect(updated).toMatchObject({
      hubUrl: "http://192.168.1.8:18800",
      userId: "user-2",
      username: "bob",
      userToken: "token-2",
      role: "member",
      connectedAt: 456,
    });
  });

  it("should store hub users, groups, and memberships", () => {
    store.upsertHubUser({
      id: "user-1",
      username: "alice",
      deviceName: "Alice Mac",
      role: "admin",
      status: "active",
      tokenHash: "hash-1",
      createdAt: 100,
      approvedAt: 110,
    });
    store.upsertHubUser({
      id: "user-2",
      username: "bob",
      deviceName: "Bob Mac",
      role: "member",
      status: "pending",
      tokenHash: "hash-2",
      createdAt: 200,
      approvedAt: null,
    });
    store.upsertHubGroup({
      id: "group-1",
      name: "Backend",
      description: "backend team",
      createdAt: 300,
    });
    store.addHubGroupMember("group-1", "user-1", 400);

    const pending = store.listHubUsers("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].username).toBe("bob");
    expect(pending[0].groups).toEqual([]);

    const groups = store.getGroupsForHubUser("user-1");
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Backend");

    const alice = store.getHubUser("user-1");
    expect(alice).not.toBeNull();
    expect(alice!.groups).toHaveLength(1);
    expect(alice!.groups[0].name).toBe("Backend");

    const users = store.listHubUsers();
    const aliceFromList = users.find((user) => user.id === "user-1");
    expect(aliceFromList).toBeDefined();
    expect(aliceFromList!.groups).toHaveLength(1);
    expect(aliceFromList!.groups[0].name).toBe("Backend");
  });

  it("should allow hub users without a device name", () => {
    store.upsertHubUser({
      id: "user-3",
      username: "carol",
      role: "member",
      status: "active",
      tokenHash: "hash-3",
      createdAt: 300,
      approvedAt: 310,
      groups: [],
    });

    const user = store.getHubUser("user-3");
    expect(user).not.toBeNull();
    expect(user!.username).toBe("carol");
    expect(user!.deviceName).toBeUndefined();
  });

  it("should upsert shared hub records idempotently by source ids", () => {
    store.upsertHubTask({
      id: "hub-task-1",
      sourceTaskId: "task-1",
      sourceUserId: "user-1",
      title: "Deploy API",
      summary: "deploy summary",
      groupId: "group-1",
      visibility: "group",
      createdAt: 1000,
      updatedAt: 1000,
    });
    store.upsertHubChunk({
      id: "hub-chunk-1",
      hubTaskId: "hub-task-1",
      sourceTaskId: "task-1",
      sourceChunkId: "chunk-1",
      sourceUserId: "user-1",
      role: "assistant",
      content: "deploy content",
      summary: "deploy summary",
      kind: "paragraph",
      createdAt: 1100,
    });
    store.upsertHubTask({
      id: "hub-task-2",
      sourceTaskId: "task-1",
      sourceUserId: "user-1",
      title: "Deploy API v2",
      summary: "updated summary",
      groupId: "group-1",
      visibility: "group",
      createdAt: 1000,
      updatedAt: 2000,
    });

    const task = store.getHubTaskBySource("user-1", "task-1");
    expect(task).not.toBeNull();
    expect(task!.id).toBe("hub-task-1");
    expect(task!.title).toBe("Deploy API v2");

    const chunk = store.getHubChunkBySource("user-1", "chunk-1");
    expect(chunk).not.toBeNull();
    expect(chunk!.hubTaskId).toBe("hub-task-1");

    store.upsertHubChunk({
      id: "hub-chunk-2",
      hubTaskId: "hub-task-1",
      sourceTaskId: "task-1",
      sourceChunkId: "chunk-2",
      sourceUserId: "user-1",
      role: "assistant",
      content: "deploy content 2",
      summary: "deploy summary 2",
      kind: "paragraph",
      createdAt: 1200,
    });

    const remappedChunk = store.getHubChunkBySource("user-1", "chunk-2");
    expect(remappedChunk).not.toBeNull();
    expect(remappedChunk!.hubTaskId).toBe("hub-task-1");

    store.upsertHubSkill({
      id: "hub-skill-1",
      sourceSkillId: "skill-1",
      sourceUserId: "user-1",
      name: "deploy-skill",
      description: "first description",
      version: 1,
      groupId: null,
      visibility: "public",
      bundle: '{"skill_md":"# deploy"}',
      qualityScore: 0.8,
      createdAt: 100,
      updatedAt: 100,
    });
    store.upsertHubSkillEmbedding("hub-skill-1", [0.1, 0.2, 0.3], "user-1", "skill-1");
    store.upsertHubSkill({
      id: "hub-skill-2",
      sourceSkillId: "skill-1",
      sourceUserId: "user-1",
      name: "deploy-skill",
      description: "updated description",
      version: 2,
      groupId: null,
      visibility: "public",
      bundle: '{"skill_md":"# deploy v2"}',
      qualityScore: 0.9,
      createdAt: 100,
      updatedAt: 200,
    });

    store.upsertHubSkillEmbedding("hub-skill-1", [0.4, 0.5, 0.6], "user-1", "skill-1");

    const skill = store.getHubSkillBySource("user-1", "skill-1");
    expect(skill).not.toBeNull();
    expect(skill!.id).toBe("hub-skill-1");
    expect(skill!.version).toBe(2);
    expect(skill!.description).toBe("updated description");
    const embedding = store.getHubSkillEmbedding("hub-skill-1");
    expect(embedding).not.toBeNull();
    expect(embedding![0]).toBeCloseTo(0.4, 5);
    expect(embedding![1]).toBeCloseTo(0.5, 5);
    expect(embedding![2]).toBeCloseTo(0.6, 5);
  });

  it("should reject mismatched parent ids even when the source tuple exists", () => {
    store.upsertHubTask({
      id: "hub-task-alice",
      sourceTaskId: "task-alice",
      sourceUserId: "user-1",
      title: "Alice task",
      summary: "alice summary",
      groupId: null,
      visibility: "public",
      createdAt: 1,
      updatedAt: 1,
    });
    store.upsertHubTask({
      id: "hub-task-bob",
      sourceTaskId: "task-bob",
      sourceUserId: "user-2",
      title: "Bob task",
      summary: "bob summary",
      groupId: null,
      visibility: "public",
      createdAt: 2,
      updatedAt: 2,
    });

    expect(() => store.upsertHubChunk({
      id: "hub-chunk-z",
      hubTaskId: "hub-task-bob",
      sourceTaskId: "task-alice",
      sourceChunkId: "chunk-alice",
      sourceUserId: "user-1",
      role: "assistant",
      content: "alice chunk",
      summary: "alice chunk",
      kind: "paragraph",
      createdAt: 3,
    })).toThrow(/mismatch/i);

    expect(store.getHubChunkBySource("user-1", "chunk-alice")).toBeNull();

    store.upsertHubSkill({
      id: "hub-skill-alice",
      sourceSkillId: "skill-alice",
      sourceUserId: "user-1",
      name: "alice-skill",
      description: "alice",
      version: 1,
      groupId: null,
      visibility: "public",
      bundle: '{"skill_md":"# alice"}',
      qualityScore: 0.7,
      createdAt: 1,
      updatedAt: 1,
    });
    store.upsertHubSkill({
      id: "hub-skill-bob",
      sourceSkillId: "skill-bob",
      sourceUserId: "user-2",
      name: "bob-skill",
      description: "bob",
      version: 1,
      groupId: null,
      visibility: "public",
      bundle: '{"skill_md":"# bob"}',
      qualityScore: 0.6,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(() => store.upsertHubSkillEmbedding("hub-skill-bob", [0.9, 0.8], "user-1", "skill-alice")).toThrow(/mismatch/i);
    expect(store.getHubSkillEmbedding("hub-skill-alice")).toBeNull();
    expect(store.getHubSkillEmbedding("hub-skill-bob")).toBeNull();
  });

  it("should reject child writes when the source tuple does not resolve to a parent", () => {
    store.upsertHubTask({
      id: "hub-task-bob-only",
      sourceTaskId: "task-bob-only",
      sourceUserId: "user-2",
      title: "Bob only",
      summary: "bob only",
      groupId: null,
      visibility: "public",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(() => store.upsertHubChunk({
      id: "hub-chunk-bad",
      hubTaskId: "hub-task-bob-only",
      sourceTaskId: "task-alice-missing",
      sourceChunkId: "chunk-missing",
      sourceUserId: "user-1",
      role: "assistant",
      content: "bad",
      summary: "bad",
      kind: "paragraph",
      createdAt: 2,
    })).toThrow(/source task/i);

    store.upsertHubSkill({
      id: "hub-skill-bob-only",
      sourceSkillId: "skill-bob-only",
      sourceUserId: "user-2",
      name: "bob-only",
      description: "bob-only",
      version: 1,
      groupId: null,
      visibility: "public",
      bundle: '{"skill_md":"# bob only"}',
      qualityScore: 0.5,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(() => store.upsertHubSkillEmbedding("hub-skill-bob-only", [0.2, 0.3], "user-1", "skill-alice-missing")).toThrow(/source skill/i);
    expect(store.getHubChunkBySource("user-1", "chunk-missing")).toBeNull();
    expect(store.getHubSkillEmbedding("hub-skill-bob-only")).toBeNull();
  });

  it("should require source identifiers for remap-sensitive child writes", () => {
    expect(() => (store as any).upsertHubChunk({
      id: "hub-chunk-x",
      hubTaskId: "hub-task-x",
      sourceChunkId: "chunk-x",
      sourceUserId: "user-1",
      role: "assistant",
      content: "x",
      summary: "x",
      kind: "paragraph",
      createdAt: 1,
    })).toThrow(/sourceTaskId/i);

    expect(() => (store as any).upsertHubSkillEmbedding("hub-skill-x", [0.1, 0.2])).toThrow(/sourceUserId and sourceSkillId/i);
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
