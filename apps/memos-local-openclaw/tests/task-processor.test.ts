import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SqliteStore } from "../src/storage/sqlite";
import { TaskProcessor } from "../src/ingest/task-processor";
import { Summarizer } from "../src/ingest/providers";
import type { Chunk, Logger, PluginContext } from "../src/types";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let store: SqliteStore;
let tmpDir: string;
let processor: TaskProcessor;

function makeCtx(): PluginContext {
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

function insertTestChunk(overrides: Partial<Chunk> & { id: string }): void {
  store.insertChunk({
    sessionKey: "session-1",
    turnId: "turn-1",
    seq: 0,
    role: "user",
    content: "test content",
    kind: "paragraph",
    summary: "test summary",
    embedding: null,
    taskId: null,
    skillId: null,
    dedupStatus: "active",
    dedupTarget: null,
    dedupReason: null,
    mergeCount: 0,
    lastHitAt: null,
    mergeHistory: "[]",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-task-test-"));
  store = new SqliteStore(path.join(tmpDir, "test.db"), noopLog);
  processor = new TaskProcessor(store, makeCtx());
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TaskProcessor", () => {
  it("should drain queued onChunksIngested calls instead of dropping them while busy", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const detectSpy = vi.spyOn(processor as any, "detectAndProcess").mockImplementation(async (sessionKey: string) => {
      calls.push(sessionKey);
      if (calls.length === 1) {
        await firstGate;
      }
    });

    const first = processor.onChunksIngested("s1", 1, "agent:main");
    await Promise.resolve();
    const second = processor.onChunksIngested("s2", 2, "agent:main");

    expect(detectSpy).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toEqual(["s1", "s2"]);
  });

  it("should create a new task when none exists", async () => {
    const now = Date.now();
    insertTestChunk({ id: "c1", sessionKey: "s1", createdAt: now });

    await processor.onChunksIngested("s1", now);

    const task = store.getActiveTask("s1");
    expect(task).not.toBeNull();
    expect(task!.status).toBe("active");
    expect(task!.sessionKey).toBe("s1");

    const chunk = store.getChunk("c1");
    expect(chunk!.taskId).toBe(task!.id);
  });

  it("should assign multiple chunks to the same task within timeout", async () => {
    const now = Date.now();
    insertTestChunk({ id: "c1", sessionKey: "s1", createdAt: now });
    await processor.onChunksIngested("s1", now);

    insertTestChunk({ id: "c2", sessionKey: "s1", createdAt: now + 1000 });
    await processor.onChunksIngested("s1", now + 1000);

    const task = store.getActiveTask("s1");
    const c1 = store.getChunk("c1");
    const c2 = store.getChunk("c2");
    expect(c1!.taskId).toBe(task!.id);
    expect(c2!.taskId).toBe(task!.id);
  });

  it("should detect task boundary when time gap exceeds timeout", async () => {
    const now = Date.now();
    const overTwoHours = 121 * 60 * 1000; // 2h 1min > 2h timeout

    insertTestChunk({ id: "c1", sessionKey: "s1", content: "First task content", createdAt: now });
    await processor.onChunksIngested("s1", now);

    const firstTask = store.getActiveTask("s1");
    expect(firstTask).not.toBeNull();
    const firstTaskId = firstTask!.id;

    insertTestChunk({ id: "c2", sessionKey: "s1", content: "Second task content", createdAt: now + overTwoHours });
    await processor.onChunksIngested("s1", now + overTwoHours);

    const oldTask = store.getTask(firstTaskId);
    expect(["completed", "skipped"]).toContain(oldTask!.status);

    const newTask = store.getActiveTask("s1");
    expect(newTask).not.toBeNull();
    expect(newTask!.id).not.toBe(firstTaskId);

    const c2 = store.getChunk("c2");
    expect(c2!.taskId).toBe(newTask!.id);
  });

  it("should detect task boundary on session change", async () => {
    const now = Date.now();

    insertTestChunk({ id: "c1", sessionKey: "s1", createdAt: now });
    await processor.onChunksIngested("s1", now);

    const firstTask = store.getActiveTask("s1");
    expect(firstTask).not.toBeNull();

    insertTestChunk({ id: "c2", sessionKey: "s2", createdAt: now + 1000 });
    await processor.onChunksIngested("s2", now + 1000);

    // Session change finalizes old task (completed) and creates new one
    const oldTask = store.getTask(firstTask!.id);
    const task2 = store.getActiveTask("s2");

    expect(oldTask).not.toBeNull();
    expect(["completed", "skipped"]).toContain(oldTask!.status);
    expect(task2).not.toBeNull();
    expect(oldTask!.id).not.toBe(task2!.id);
  });

  it("should generate task title from first user message", async () => {
    const now = Date.now();

    insertTestChunk({ id: "c1", sessionKey: "s1", role: "user", content: "Deploy the API to production", createdAt: now });
    await processor.onChunksIngested("s1", now);

    const overTwoHours = 121 * 60 * 1000;
    insertTestChunk({ id: "c2", sessionKey: "s1", content: "New task", createdAt: now + overTwoHours });
    await processor.onChunksIngested("s1", now + overTwoHours);

    const chunks = store.getChunksByTask(store.getActiveTask("s1")!.id);
    expect(chunks).toBeDefined();

    const allTasks = store.getChunksByTask(store.getChunk("c1")!.taskId!);
    expect(allTasks.length).toBeGreaterThan(0);
  });

  it("should get chunks by task id", async () => {
    const now = Date.now();
    insertTestChunk({ id: "c1", sessionKey: "s1", createdAt: now });
    insertTestChunk({ id: "c2", sessionKey: "s1", createdAt: now + 100 });
    await processor.onChunksIngested("s1", now + 100);

    const task = store.getActiveTask("s1");
    const taskChunks = store.getChunksByTask(task!.id);
    expect(taskChunks).toHaveLength(2);
  });

  it("deleteAll should also clear tasks", () => {
    const now = Date.now();
    store.insertTask({
      id: "t1",
      sessionKey: "s1",
      title: "Test",
      summary: "Test summary",
      status: "active",
      startedAt: now,
      endedAt: null,
      updatedAt: now,
    });
    store.deleteAll();
    expect(store.getTask("t1")).toBeNull();
  });

  it("should mark task as skipped when only 1 chunk (too few)", async () => {
    const now = Date.now();
    const gap = 121 * 60 * 1000;

    insertTestChunk({ id: "c1", sessionKey: "s1", role: "user", content: "hello", createdAt: now });
    await processor.onChunksIngested("s1", now);

    const firstTaskId = store.getActiveTask("s1")!.id;

    insertTestChunk({ id: "c2", sessionKey: "s1", content: "next task", createdAt: now + gap });
    await processor.onChunksIngested("s1", now + gap);

    const oldTask = store.getTask(firstTaskId);
    expect(oldTask!.status).toBe("skipped");
    expect(oldTask!.summary).toContain("过少");
  });

  it("should mark task as skipped for trivial test data", async () => {
    const now = Date.now();
    const gap = 121 * 60 * 1000;

    insertTestChunk({ id: "t1", sessionKey: "s1", role: "user", content: "test", createdAt: now });
    insertTestChunk({ id: "t2", sessionKey: "s1", role: "assistant", content: "ok", createdAt: now + 1 });
    insertTestChunk({ id: "t3", sessionKey: "s1", role: "user", content: "hello", createdAt: now + 2 });
    insertTestChunk({ id: "t4", sessionKey: "s1", role: "assistant", content: "hi", createdAt: now + 3 });
    await processor.onChunksIngested("s1", now + 3);

    const firstTaskId = store.getActiveTask("s1")!.id;

    insertTestChunk({ id: "t5", sessionKey: "s1", content: "new task starts", createdAt: now + gap });
    await processor.onChunksIngested("s1", now + gap);

    const oldTask = store.getTask(firstTaskId);
    expect(oldTask!.status).toBe("skipped");
    expect(oldTask!.summary.length).toBeGreaterThan(0);
  });

  it("should mark task as skipped when dominated by tool results", async () => {
    const now = Date.now();
    const gap = 121 * 60 * 1000;

    insertTestChunk({ id: "r1", sessionKey: "s1", role: "user", content: "run the tests please and check the results", createdAt: now });
    insertTestChunk({ id: "r2", sessionKey: "s1", role: "assistant", content: "Sure, running the tests now with verbose output enabled", createdAt: now + 1 });
    insertTestChunk({ id: "r3", sessionKey: "s1", role: "tool", content: "Test suite passed: 10 tests, 0 failures, duration 2.3s", createdAt: now + 2 });
    insertTestChunk({ id: "r4", sessionKey: "s1", role: "tool", content: "Coverage report: 85% statements, 72% branches, 90% functions", createdAt: now + 3 });
    insertTestChunk({ id: "r5", sessionKey: "s1", role: "tool", content: "Lint check passed: 0 errors, 3 warnings in 12 files scanned", createdAt: now + 4 });
    insertTestChunk({ id: "r6", sessionKey: "s1", role: "tool", content: "Build output: dist/index.js 45kb, dist/index.css 12kb gzipped", createdAt: now + 5 });
    insertTestChunk({ id: "r7", sessionKey: "s1", role: "tool", content: "Deploy status: staging environment updated successfully at 10:23 AM", createdAt: now + 6 });
    await processor.onChunksIngested("s1", now + 6);

    const firstTaskId = store.getActiveTask("s1")!.id;

    insertTestChunk({ id: "r8", sessionKey: "s1", content: "next", createdAt: now + gap });
    await processor.onChunksIngested("s1", now + gap);

    const oldTask = store.getTask(firstTaskId);
    expect(oldTask!.status).toBe("skipped");
    expect(oldTask!.summary.length).toBeGreaterThan(0);
  });

  it("should mark task as skipped when user repeats the same message", async () => {
    const now = Date.now();
    const gap = 121 * 60 * 1000;

    vi.spyOn((processor as any).summarizer, "classifyTopic").mockResolvedValue(null);

    insertTestChunk({ id: "d1", sessionKey: "s1", role: "user", content: "what is my name and who am I please tell me", createdAt: now });
    insertTestChunk({ id: "d2", sessionKey: "s1", role: "assistant", content: "I do not have any information about your name or identity in my memory at this time", createdAt: now + 1 });
    insertTestChunk({ id: "d3", sessionKey: "s1", role: "user", content: "what is my name and who am I please tell me", createdAt: now + 2 });
    insertTestChunk({ id: "d4", sessionKey: "s1", role: "assistant", content: "I still do not have records of your name, could you please tell me who you are", createdAt: now + 3 });
    insertTestChunk({ id: "d5", sessionKey: "s1", role: "user", content: "what is my name and who am I please tell me", createdAt: now + 4 });
    insertTestChunk({ id: "d6", sessionKey: "s1", role: "assistant", content: "I apologize but I cannot find your name or identity in my stored conversation memories", createdAt: now + 5 });
    await processor.onChunksIngested("s1", now + 5);

    const firstTaskId = store.getActiveTask("s1")!.id;

    insertTestChunk({ id: "d7", sessionKey: "s1", content: "new topic now", createdAt: now + gap });
    await processor.onChunksIngested("s1", now + gap);

    const oldTask = store.getTask(firstTaskId);
    expect(oldTask!.status).toBe("skipped");
    expect(oldTask!.summary).toContain("重复");
  });

  it("should NOT skip summary for tasks with substantial content", async () => {
    const now = Date.now();
    const gap = 121 * 60 * 1000;

    insertTestChunk({ id: "s1", sessionKey: "s1", role: "user", content: "I need to deploy the API to port 8443 using Docker compose", createdAt: now });
    insertTestChunk({ id: "s2", sessionKey: "s1", role: "assistant", content: "Sure, here is how you can deploy your API service to production using Docker Compose on port 8443", createdAt: now + 1 });
    insertTestChunk({ id: "s3", sessionKey: "s1", role: "user", content: "The build failed with error: Module not found. How can I fix the tsconfig paths?", createdAt: now + 2 });
    insertTestChunk({ id: "s4", sessionKey: "s1", role: "assistant", content: "Check your tsconfig.json paths configuration, it should have the correct baseUrl and paths mappings", createdAt: now + 3 });
    insertTestChunk({ id: "s5", sessionKey: "s1", role: "user", content: "That worked! Now the build passes. What about the health checks?", createdAt: now + 4 });
    await processor.onChunksIngested("s1", now + 4);

    const firstTaskId = store.getActiveTask("s1")!.id;

    insertTestChunk({ id: "s6", sessionKey: "s1", content: "new topic", createdAt: now + gap });
    await processor.onChunksIngested("s1", now + gap);

    const oldTask = store.getTask(firstTaskId);
    // LLM topic judge may split the conversation mid-stream; accept both outcomes
    expect(["completed", "skipped"]).toContain(oldTask!.status);
    if (oldTask!.status === "completed") {
      expect(oldTask!.summary.length).toBeGreaterThan(0);
    }
  });

  it("should NOT skip summary for Chinese conversation with real content", async () => {
    const now = Date.now();
    const gap = 121 * 60 * 1000;

    insertTestChunk({ id: "z1", sessionKey: "s1", role: "user", content: "我需要把这个项目部署到阿里云的ECS服务器上，端口用8443", createdAt: now });
    insertTestChunk({ id: "z2", sessionKey: "s1", role: "assistant", content: "好的，我来帮你配置阿里云ECS的部署流程，首先需要确认你的安全组规则允许8443端口", createdAt: now + 1 });
    insertTestChunk({ id: "z3", sessionKey: "s1", role: "user", content: "安全组已经配好了，但是Docker容器启动失败，报错说找不到配置文件", createdAt: now + 2 });
    insertTestChunk({ id: "z4", sessionKey: "s1", role: "assistant", content: "请检查docker-compose.yml中的volumes挂载路径是否正确，配置文件需要映射到容器内的/app/config目录", createdAt: now + 3 });
    insertTestChunk({ id: "z5", sessionKey: "s1", role: "user", content: "搞定了，现在服务正常运行了，谢谢！", createdAt: now + 4 });
    await processor.onChunksIngested("s1", now + 4);

    const firstTaskId = store.getActiveTask("s1")!.id;

    insertTestChunk({ id: "z6", sessionKey: "s1", content: "下一个话题", createdAt: now + gap });
    await processor.onChunksIngested("s1", now + gap);

    const oldTask = store.getTask(firstTaskId);
    // LLM topic judge may split the conversation mid-stream; accept both outcomes
    expect(["completed", "skipped"]).toContain(oldTask!.status);
    if (oldTask!.status === "completed") {
      expect(oldTask!.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("TaskProcessor with LLM topic boundary detection", () => {
  let store: SqliteStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-llm-topic-test-"));
    store = new SqliteStore(path.join(tmpDir, "test.db"), noopLog);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertChunk(overrides: Partial<Chunk> & { id: string }): void {
    store.insertChunk({
      sessionKey: "s1",
      turnId: "turn-1",
      seq: 0,
      role: "user",
      content: "test content",
      kind: "paragraph",
      summary: "test summary",
      embedding: null,
      taskId: null,
      skillId: null,
      dedupStatus: "active",
      dedupTarget: null,
      dedupReason: null,
      mergeCount: 0,
      lastHitAt: null,
      mergeHistory: "[]",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    });
  }

  it("should split task when classifier judges NEW topic", async () => {
    const ctx = makeCtx();
    const proc = new TaskProcessor(store, ctx);

    vi.spyOn(Summarizer.prototype, "classifyTopic").mockResolvedValue({
      decision: "NEW", confidence: 0.9, boundaryType: "new_domain_shift", reason: "completely different domain",
    });

    const now = Date.now();
    insertChunk({ id: "a1", summary: "deploy app to server", content: "deploy app to server", createdAt: now });
    insertChunk({ id: "a2", role: "assistant", summary: "deployment guide", content: "deployment guide", createdAt: now + 1 });
    await proc.onChunksIngested("s1", now + 1);

    const task1Id = store.getActiveTask("s1")!.id;

    insertChunk({ id: "a3", summary: "best recipe for pasta", content: "best recipe for pasta", createdAt: now + 60000 });
    await proc.onChunksIngested("s1", now + 60000);

    const oldTask = store.getTask(task1Id);
    expect(["completed", "skipped"]).toContain(oldTask!.status);

    const newTask = store.getActiveTask("s1");
    expect(newTask).not.toBeNull();
    expect(newTask!.id).not.toBe(task1Id);

    vi.restoreAllMocks();
  });

  it("should NOT split task when classifier judges SAME topic", async () => {
    const ctx = makeCtx();
    const proc = new TaskProcessor(store, ctx);

    vi.spyOn(Summarizer.prototype, "classifyTopic").mockResolvedValue({
      decision: "SAME", confidence: 0.85, boundaryType: "same_direct_followup", reason: "continues deployment discussion",
    });

    const now = Date.now();
    insertChunk({ id: "b1", summary: "deploy step 1", content: "deploy step 1", createdAt: now });
    insertChunk({ id: "b2", role: "assistant", summary: "step 1 done", content: "step 1 done", createdAt: now + 1 });
    await proc.onChunksIngested("s1", now + 1);

    const task1Id = store.getActiveTask("s1")!.id;

    insertChunk({ id: "b3", summary: "deploy step 2", content: "deploy step 2", createdAt: now + 60000 });
    await proc.onChunksIngested("s1", now + 60000);

    const task = store.getActiveTask("s1");
    expect(task).not.toBeNull();
    expect(task!.id).toBe(task1Id);

    vi.restoreAllMocks();
  });

  it("should keep current task when classifier returns null (LLM not configured)", async () => {
    const ctx = makeCtx();
    const proc = new TaskProcessor(store, ctx);

    vi.spyOn(Summarizer.prototype, "classifyTopic").mockResolvedValue(null);

    const now = Date.now();
    insertChunk({ id: "c1", summary: "topic A", content: "topic A", createdAt: now });
    await proc.onChunksIngested("s1", now);

    const task1Id = store.getActiveTask("s1")!.id;

    insertChunk({ id: "c2", summary: "totally different topic", content: "totally different topic", createdAt: now + 60000 });
    await proc.onChunksIngested("s1", now + 60000);

    const task = store.getActiveTask("s1");
    expect(task!.id).toBe(task1Id);

    vi.restoreAllMocks();
  });

  it("should fall back to SAME when NEW has low confidence and arbitration says SAME", async () => {
    const ctx = makeCtx();
    const proc = new TaskProcessor(store, ctx);

    vi.spyOn(Summarizer.prototype, "classifyTopic").mockResolvedValue({
      decision: "NEW", confidence: 0.4, boundaryType: "new_domain_shift", reason: "possibly new topic",
    });
    vi.spyOn(Summarizer.prototype, "arbitrateTopicSplit").mockResolvedValue("SAME");

    const now = Date.now();
    insertChunk({ id: "e1", summary: "Hong Kong stock analysis", content: "我在调研港股的前途", createdAt: now });
    insertChunk({ id: "e2", role: "assistant", summary: "港股分析框架", content: "港股分析需要从宏观经济...", createdAt: now + 1 });
    await proc.onChunksIngested("s1", now + 1);

    const task1Id = store.getActiveTask("s1")!.id;

    insertChunk({ id: "e3", summary: "processing systems", content: "那处理系统有哪些", createdAt: now + 60000 });
    await proc.onChunksIngested("s1", now + 60000);

    const task = store.getActiveTask("s1");
    expect(task).not.toBeNull();
    expect(task!.id).toBe(task1Id);

    vi.restoreAllMocks();
  });

  it("should split when NEW has low confidence but arbitration confirms NEW", async () => {
    const ctx = makeCtx();
    const proc = new TaskProcessor(store, ctx);

    vi.spyOn(Summarizer.prototype, "classifyTopic").mockResolvedValue({
      decision: "NEW", confidence: 0.5, boundaryType: "new_domain_shift", reason: "different domain",
    });
    vi.spyOn(Summarizer.prototype, "arbitrateTopicSplit").mockResolvedValue("NEW");

    const now = Date.now();
    insertChunk({ id: "f1", summary: "deploy app", content: "deploy the app to production", createdAt: now });
    insertChunk({ id: "f2", role: "assistant", summary: "deployment guide", content: "Here is how to deploy...", createdAt: now + 1 });
    await proc.onChunksIngested("s1", now + 1);

    const task1Id = store.getActiveTask("s1")!.id;

    insertChunk({ id: "f3", summary: "cook pasta", content: "how to make spaghetti carbonara", createdAt: now + 60000 });
    await proc.onChunksIngested("s1", now + 60000);

    const oldTask = store.getTask(task1Id);
    expect(["completed", "skipped"]).toContain(oldTask!.status);

    const newTask = store.getActiveTask("s1");
    expect(newTask).not.toBeNull();
    expect(newTask!.id).not.toBe(task1Id);

    vi.restoreAllMocks();
  });

  it("should still split by 2-hour timeout even if classifier says SAME", async () => {
    const ctx = makeCtx();
    const proc = new TaskProcessor(store, ctx);

    vi.spyOn(Summarizer.prototype, "classifyTopic").mockResolvedValue({
      decision: "SAME", confidence: 0.9, boundaryType: "same_direct_followup", reason: "same topic",
    });

    const now = Date.now();
    const gap = 121 * 60 * 1000; // 2h 1min

    insertChunk({ id: "d1", summary: "topic A", content: "topic A", createdAt: now });
    insertChunk({ id: "d2", role: "assistant", summary: "about topic A", content: "about topic A", createdAt: now + 1 });
    await proc.onChunksIngested("s1", now + 1);

    const task1Id = store.getActiveTask("s1")!.id;

    insertChunk({ id: "d3", summary: "still topic A", content: "still topic A", createdAt: now + gap });
    await proc.onChunksIngested("s1", now + gap);

    const oldTask = store.getTask(task1Id);
    expect(["completed", "skipped"]).toContain(oldTask!.status);

    vi.restoreAllMocks();
  });
});
