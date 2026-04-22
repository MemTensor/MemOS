import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import plugin from "../plugin-impl";
import { SqliteStore } from "../src/storage/sqlite";
import { HubServer } from "../src/hub/server";

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeApi(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const tools = new Map<string, any>();
  const events = new Map<string, Function>();
  let service: any;

  const api = {
    pluginConfig,
    resolvePath(input: string) {
      return input === "~/.openclaw" ? stateDir : input;
    },
    logger: noopLog,
    registerTool(def: any, meta?: { name?: string }) {
      if (typeof def === "function") {
        const key = meta?.name ?? def({ agentId: "main", sessionKey: "default" }).name;
        tools.set(key, {
          name: key,
          execute: (...args: any[]) => {
            const runtimeCtx = args[2] ?? { agentId: "main", sessionKey: "default" };
            return def(runtimeCtx).execute(...args);
          },
        });
        return;
      }
      tools.set(def.name, def);
    },
    registerMemoryCapability() {},
    registerService(def: any) {
      service = def;
    },
    on(eventName: string, handler: Function) {
      events.set(eventName, handler);
    },
  } as any;

  plugin.register(api);
  return { tools, events, service };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

let tmpDirs: string[] = [];
let stores: SqliteStore[] = [];
let hubServer: HubServer | null = null;
let service: any = null;

afterEach(async () => {
  await service?.stop?.();
  service = null;
  await hubServer?.stop();
  hubServer = null;
  for (const store of stores.splice(0)) store.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("incremental shared task sync", () => {
  it("pushes newly added chunks without changing visibility metadata", async () => {
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-incremental-client-"));
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-incremental-hub-"));
    tmpDirs.push(clientDir, hubDir);

    const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog as any);
    stores.push(hubStore);
    const port = 18930 + Math.floor(Math.random() * 500);
    hubServer = new HubServer({
      store: hubStore,
      log: noopLog as any,
      config: { sharing: { enabled: true, role: "hub", hub: { port, teamName: "Incremental", teamToken: "incremental-secret" } } } as any,
      dataDir: hubDir,
    } as any);
    await hubServer.start();

    const state = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
    const userToken = state.bootstrapAdminToken as string;
    const userId = state.bootstrapAdminUserId as string;

    const api = makeApi(clientDir, {
      sharing: {
        enabled: true,
        role: "client",
        client: { hubAddress: `127.0.0.1:${port}`, userToken },
      },
    });
    service = api.service;

    const dbPath = path.join(clientDir, "memos-local", "memos.db");
    const clientStore = new SqliteStore(dbPath, noopLog as any);
    stores.push(clientStore);
    clientStore.insertTask({ id: "task-inc-1", sessionKey: "inc-session", title: "Incremental task", summary: "incremental summary", status: "completed", owner: "agent:main", startedAt: 1, endedAt: 2, updatedAt: 2 });
    clientStore.insertChunk({ id: "chunk-inc-1", sessionKey: "inc-session", turnId: "turn-1", seq: 0, role: "user", content: "first chunk", kind: "paragraph", summary: "first chunk", embedding: null, taskId: "task-inc-1", skillId: null, owner: "agent:main", dedupStatus: "active", dedupTarget: null, dedupReason: null, mergeCount: 0, lastHitAt: null, mergeHistory: "[]", createdAt: 3, updatedAt: 3 });

    const shareTool = api.tools.get("task_share");
    const shareResult = await shareTool.execute("call-share", { taskId: "task-inc-1", visibility: "group", groupId: "group-alpha" }, { agentId: "main" });
    expect(shareResult.details.shared).toBe(true);

    clientStore.insertChunk({ id: "chunk-inc-2", sessionKey: "inc-session", turnId: "turn-2", seq: 1, role: "assistant", content: "second chunk", kind: "paragraph", summary: "second chunk", embedding: null, taskId: "task-inc-1", skillId: null, owner: "agent:main", dedupStatus: "active", dedupTarget: null, dedupReason: null, mergeCount: 0, lastHitAt: null, mergeHistory: "[]", createdAt: 4, updatedAt: 4 });

    const agentEnd = api.events.get("agent_end")!;
    await agentEnd({
      success: true,
      agentId: "main",
      sessionKey: "inc-session",
      messages: [
        { role: "user", content: "trigger incremental sync" },
        { role: "assistant", content: "incremental sync acknowledged" },
      ],
    });

    await waitFor(() => hubStore.getHubChunkBySource(userId, "chunk-inc-2") != null, 5000);
    const sharedTask = hubStore.getHubTaskBySource(userId, "task-inc-1");
    expect(sharedTask?.visibility).toBe("group");
    expect(sharedTask?.groupId).toBe("group-alpha");
  });
});
