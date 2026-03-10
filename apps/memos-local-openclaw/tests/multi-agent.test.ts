import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SqliteStore } from "../src/storage/sqlite";
import { cosineSimilarity, vectorSearch } from "../src/storage/vector";
import type { Chunk, Skill, Logger } from "../src/types";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let store: SqliteStore;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-multi-agent-"));
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

describe("Multi-Agent Memory Isolation", () => {
  it("should store and retrieve chunks with owner", () => {
    store.insertChunk(makeChunk({ id: "c1", owner: "agent:alpha", content: "Alpha memory" }));
    store.insertChunk(makeChunk({ id: "c2", owner: "agent:beta", content: "Beta memory" }));
    store.insertChunk(makeChunk({ id: "c3", owner: "public", content: "Public memory" }));

    const c1 = store.getChunk("c1");
    expect(c1!.owner).toBe("agent:alpha");
    const c2 = store.getChunk("c2");
    expect(c2!.owner).toBe("agent:beta");
    const c3 = store.getChunk("c3");
    expect(c3!.owner).toBe("public");
  });

  it("FTS search should filter by owner", () => {
    store.insertChunk(makeChunk({
      id: "c1", owner: "agent:alpha",
      content: "TypeScript deployment guide",
      summary: "TypeScript deployment guide",
    }));
    store.insertChunk(makeChunk({
      id: "c2", owner: "agent:beta",
      content: "TypeScript testing patterns",
      summary: "TypeScript testing patterns",
    }));
    store.insertChunk(makeChunk({
      id: "c3", owner: "public",
      content: "TypeScript best practices shared",
      summary: "TypeScript best practices shared",
    }));

    // Alpha sees own + public
    const alphaResults = store.ftsSearch("TypeScript", 10, ["agent:alpha", "public"]);
    const alphaIds = alphaResults.map(r => r.chunkId);
    expect(alphaIds).toContain("c1");
    expect(alphaIds).toContain("c3");
    expect(alphaIds).not.toContain("c2");

    // Beta sees own + public
    const betaResults = store.ftsSearch("TypeScript", 10, ["agent:beta", "public"]);
    const betaIds = betaResults.map(r => r.chunkId);
    expect(betaIds).toContain("c2");
    expect(betaIds).toContain("c3");
    expect(betaIds).not.toContain("c1");

    // No filter sees all
    const allResults = store.ftsSearch("TypeScript", 10);
    expect(allResults.length).toBe(3);
  });

  it("vector search should filter by owner", () => {
    const vec1 = [0.1, 0.2, 0.3, 0.4, 0.5];
    const vec2 = [0.15, 0.25, 0.35, 0.45, 0.55];
    const vec3 = [0.2, 0.3, 0.4, 0.5, 0.6];

    store.insertChunk(makeChunk({ id: "c1", owner: "agent:alpha" }));
    store.insertChunk(makeChunk({ id: "c2", owner: "agent:beta" }));
    store.insertChunk(makeChunk({ id: "c3", owner: "public" }));

    store.upsertEmbedding("c1", vec1);
    store.upsertEmbedding("c2", vec2);
    store.upsertEmbedding("c3", vec3);

    const queryVec = [0.1, 0.2, 0.3, 0.4, 0.5];

    // Alpha sees own + public
    const alphaResults = vectorSearch(store, queryVec, 10, undefined, ["agent:alpha", "public"]);
    const alphaIds = alphaResults.map(r => r.chunkId);
    expect(alphaIds).toContain("c1");
    expect(alphaIds).toContain("c3");
    expect(alphaIds).not.toContain("c2");

    // No filter sees all
    const allResults = vectorSearch(store, queryVec, 10);
    expect(allResults.length).toBe(3);
  });
});

describe("Skill Visibility", () => {
  function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
      id: overrides.id ?? "skill-1",
      name: overrides.name ?? "test-skill",
      description: "A test skill",
      version: 1,
      status: "active",
      tags: "[]",
      sourceType: "task",
      dirPath: "/tmp/skills/test",
      installed: 0,
      owner: "agent:main",
      visibility: "private",
      qualityScore: 8,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  it("should store skill with owner and visibility", () => {
    store.insertSkill(makeSkill({ id: "s1", owner: "agent:alpha", visibility: "public" }));
    const skill = store.getSkill("s1");
    expect(skill!.owner).toBe("agent:alpha");
    expect(skill!.visibility).toBe("public");
  });

  it("should toggle skill visibility", () => {
    store.insertSkill(makeSkill({ id: "s1" }));
    expect(store.getSkill("s1")!.visibility).toBe("private");

    store.setSkillVisibility("s1", "public");
    expect(store.getSkill("s1")!.visibility).toBe("public");

    store.setSkillVisibility("s1", "private");
    expect(store.getSkill("s1")!.visibility).toBe("private");
  });

  it("should list public skills", () => {
    store.insertSkill(makeSkill({ id: "s1", name: "skill-a", visibility: "private" }));
    store.insertSkill(makeSkill({ id: "s2", name: "skill-b", visibility: "public" }));
    store.insertSkill(makeSkill({ id: "s3", name: "skill-c", visibility: "public" }));

    const publicSkills = store.listPublicSkills();
    expect(publicSkills.length).toBe(2);
    expect(publicSkills.map(s => s.id)).toContain("s2");
    expect(publicSkills.map(s => s.id)).toContain("s3");
  });

  it("skill FTS should scope by visibility", () => {
    store.insertSkill(makeSkill({
      id: "s1", name: "docker-deploy", description: "Docker deployment guide",
      owner: "agent:alpha", visibility: "private",
    }));
    store.insertSkill(makeSkill({
      id: "s2", name: "docker-compose", description: "Docker compose workflow",
      owner: "agent:beta", visibility: "public",
    }));
    store.insertSkill(makeSkill({
      id: "s3", name: "docker-k8s", description: "Docker Kubernetes integration",
      owner: "agent:alpha", visibility: "public",
    }));

    // Self: alpha sees only own
    const selfResults = store.skillFtsSearch("Docker", 10, "self", "agent:alpha");
    expect(selfResults.map(r => r.skillId)).toContain("s1");
    expect(selfResults.map(r => r.skillId)).toContain("s3");
    expect(selfResults.map(r => r.skillId)).not.toContain("s2");

    // Public: sees only public skills
    const publicResults = store.skillFtsSearch("Docker", 10, "public", "agent:alpha");
    expect(publicResults.map(r => r.skillId)).toContain("s2");
    expect(publicResults.map(r => r.skillId)).toContain("s3");
    expect(publicResults.map(r => r.skillId)).not.toContain("s1");

    // Mix: sees own + public
    const mixResults = store.skillFtsSearch("Docker", 10, "mix", "agent:alpha");
    expect(mixResults.length).toBe(3);
  });

  it("should store and retrieve skill embeddings", () => {
    store.insertSkill(makeSkill({ id: "s1", name: "embed-test", visibility: "public" }));
    const vec = [0.1, 0.2, 0.3, 0.4, 0.5];
    store.upsertSkillEmbedding("s1", vec);

    const retrieved = store.getSkillEmbedding("s1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.length).toBe(5);
    expect(retrieved![0]).toBeCloseTo(0.1, 4);
  });

  it("skill embeddings should scope by visibility", () => {
    store.insertSkill(makeSkill({ id: "s1", name: "priv-skill", owner: "agent:alpha", visibility: "private" }));
    store.insertSkill(makeSkill({ id: "s2", name: "pub-skill", owner: "agent:beta", visibility: "public" }));

    store.upsertSkillEmbedding("s1", [0.1, 0.2, 0.3]);
    store.upsertSkillEmbedding("s2", [0.4, 0.5, 0.6]);

    // Self: alpha sees own
    const selfEmb = store.getSkillEmbeddings("self", "agent:alpha");
    expect(selfEmb.length).toBe(1);
    expect(selfEmb[0].skillId).toBe("s1");

    // Public: sees only public
    const pubEmb = store.getSkillEmbeddings("public", "agent:alpha");
    expect(pubEmb.length).toBe(1);
    expect(pubEmb[0].skillId).toBe("s2");

    // Mix: alpha sees own + public
    const mixEmb = store.getSkillEmbeddings("mix", "agent:alpha");
    expect(mixEmb.length).toBe(2);
  });
});

describe("Task Owner", () => {
  it("should store task with owner", () => {
    store.insertTask({
      id: "t1",
      sessionKey: "session-1",
      title: "Test Task",
      summary: "Test summary",
      status: "active",
      owner: "agent:alpha",
      startedAt: Date.now(),
      endedAt: null,
      updatedAt: Date.now(),
    });

    const task = store.getTask("t1");
    expect(task!.owner).toBe("agent:alpha");
  });

  it("getActiveTask should filter by owner", () => {
    const now = Date.now();
    store.insertTask({
      id: "t1", sessionKey: "s1", title: "Alpha Task", summary: "",
      status: "active", owner: "agent:alpha", startedAt: now, endedAt: null, updatedAt: now,
    });
    store.insertTask({
      id: "t2", sessionKey: "s1", title: "Beta Task", summary: "",
      status: "active", owner: "agent:beta", startedAt: now + 1, endedAt: null, updatedAt: now + 1,
    });

    const alphaTask = store.getActiveTask("s1", "agent:alpha");
    expect(alphaTask).not.toBeNull();
    expect(alphaTask!.id).toBe("t1");

    const betaTask = store.getActiveTask("s1", "agent:beta");
    expect(betaTask).not.toBeNull();
    expect(betaTask!.id).toBe("t2");

    // Without owner filter, returns the most recent
    const anyTask = store.getActiveTask("s1");
    expect(anyTask).not.toBeNull();
    expect(anyTask!.id).toBe("t2");
  });

  it("getAllActiveTasks should filter by owner", () => {
    const now = Date.now();
    store.insertTask({
      id: "t1", sessionKey: "s1", title: "Alpha Task", summary: "",
      status: "active", owner: "agent:alpha", startedAt: now, endedAt: null, updatedAt: now,
    });
    store.insertTask({
      id: "t2", sessionKey: "s2", title: "Beta Task", summary: "",
      status: "active", owner: "agent:beta", startedAt: now, endedAt: null, updatedAt: now,
    });

    const alphaTasks = store.getAllActiveTasks("agent:alpha");
    expect(alphaTasks.length).toBe(1);
    expect(alphaTasks[0].id).toBe("t1");

    const betaTasks = store.getAllActiveTasks("agent:beta");
    expect(betaTasks.length).toBe(1);
    expect(betaTasks[0].id).toBe("t2");

    const allTasks = store.getAllActiveTasks();
    expect(allTasks.length).toBe(2);
  });

  it("getUnassignedChunks should filter by owner", () => {
    store.insertChunk(makeChunk({ id: "c1", owner: "agent:alpha", content: "Alpha msg" }));
    store.insertChunk(makeChunk({ id: "c2", owner: "agent:beta", content: "Beta msg" }));

    const alphaChunks = store.getUnassignedChunks("session-1", "agent:alpha");
    expect(alphaChunks.length).toBe(1);
    expect(alphaChunks[0].id).toBe("c1");

    const betaChunks = store.getUnassignedChunks("session-1", "agent:beta");
    expect(betaChunks.length).toBe(1);
    expect(betaChunks[0].id).toBe("c2");

    const allChunks = store.getUnassignedChunks("session-1");
    expect(allChunks.length).toBe(2);
  });

  it("listTasks should filter by owner", () => {
    const now = Date.now();
    store.insertTask({
      id: "t1", sessionKey: "s1", title: "Alpha Task", summary: "",
      status: "completed", owner: "agent:alpha", startedAt: now, endedAt: now + 1000, updatedAt: now,
    });
    store.insertTask({
      id: "t2", sessionKey: "s1", title: "Beta Task", summary: "",
      status: "completed", owner: "agent:beta", startedAt: now, endedAt: now + 1000, updatedAt: now,
    });

    const alphaResult = store.listTasks({ owner: "agent:alpha" });
    expect(alphaResult.total).toBe(1);
    expect(alphaResult.tasks[0].id).toBe("t1");

    const allResult = store.listTasks();
    expect(allResult.total).toBe(2);
  });
});
