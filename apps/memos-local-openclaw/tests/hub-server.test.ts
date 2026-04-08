import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { HubServer } from "../src/hub/server";

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const servers: HubServer[] = [];
const stores: SqliteStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("hub server", () => {
  it("should preserve bootstrap admin token across restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-auth-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "test.db");

    const store1 = new SqliteStore(dbPath, noopLog);
    stores.push(store1);
    const server1 = new HubServer({
      store: store1,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18912, teamName: "Persist", teamToken: "persist-secret" } } },
      dataDir: dir,
    } as any);
    servers.push(server1);
    await server1.start();

    const authPath = path.join(dir, "hub-auth.json");
    const firstState = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const firstToken = firstState.bootstrapAdminToken;
    expect(firstToken).toBeTruthy();

    const firstMe = await fetch("http://127.0.0.1:18912/api/v1/hub/me", {
      headers: { authorization: `Bearer ${firstToken}` },
    });
    expect(firstMe.status).toBe(200);

    await server1.stop();
    servers.pop();
    store1.close();
    stores.pop();

    const store2 = new SqliteStore(dbPath, noopLog);
    stores.push(store2);
    const server2 = new HubServer({
      store: store2,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18912, teamName: "Persist", teamToken: "persist-secret" } } },
      dataDir: dir,
    } as any);
    servers.push(server2);
    await server2.start();

    const secondMe = await fetch("http://127.0.0.1:18912/api/v1/hub/me", {
      headers: { authorization: `Bearer ${firstToken}` },
    });
    expect(secondMe.status).toBe(200);
  });

  it("should recover bootstrap metadata for legacy hubs with an existing admin", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-legacy-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "test.db");
    const authPath = path.join(dir, "hub-auth.json");

    const store = new SqliteStore(dbPath, noopLog);
    stores.push(store);
    store.upsertHubUser({
      id: "legacy-admin",
      username: "legacy",
      deviceName: "hub",
      role: "admin",
      status: "active",
      groups: [],
      tokenHash: "",
      createdAt: 1,
      approvedAt: 1,
    });
    fs.writeFileSync(authPath, JSON.stringify({ authSecret: "legacy-secret" }, null, 2), "utf8");

    const server = new HubServer({
      store,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18913, teamName: "Legacy", teamToken: "legacy-team-token" } } },
      dataDir: dir,
    } as any);
    servers.push(server);
    await server.start();

    const state = JSON.parse(fs.readFileSync(authPath, "utf8"));
    expect(state.bootstrapAdminUserId).toBe("legacy-admin");
    expect(state.bootstrapAdminToken).toBeTruthy();

    const me = await fetch("http://127.0.0.1:18913/api/v1/hub/me", {
      headers: { authorization: `Bearer ${state.bootstrapAdminToken}` },
    });
    expect(me.status).toBe(200);
  });

  it("should refuse to start hub mode without a team token", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-no-token-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "test.db"), noopLog);
    stores.push(store);

    const server = new HubServer({
      store,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18914, teamName: "NoToken", teamToken: "" } } },
      dataDir: dir,
    } as any);
    servers.push(server);

    await expect(server.start()).rejects.toThrow(/team token/i);
  });

  it("should fall back to the next available port on conflict", async () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-1-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-2-"));
    dirs.push(dir1, dir2);

    const store1 = new SqliteStore(path.join(dir1, "test.db"), noopLog);
    const store2 = new SqliteStore(path.join(dir2, "test.db"), noopLog);
    stores.push(store1, store2);

    const server1 = new HubServer({
      store: store1,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18911, teamName: "A", teamToken: "secret-a" } } },
      dataDir: dir1,
    } as any);
    const server2 = new HubServer({
      store: store2,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18911, teamName: "B", teamToken: "secret-b" } } },
      dataDir: dir2,
    } as any);
    servers.push(server1, server2);

    const url1 = await server1.start();
    const url2 = await server2.start();

    expect(url1).toBe("http://127.0.0.1:18911");
    expect(url2).toBe("http://127.0.0.1:18912");
  });

  it("should keep shared resources for offline users until they explicitly leave", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-offline-"));
    dirs.push(dir);

    const store = new SqliteStore(path.join(dir, "test.db"), noopLog);
    stores.push(store);

    const server = new HubServer({
      store,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18914, teamName: "Offline", teamToken: "offline-secret" } } },
      dataDir: dir,
    } as any);
    servers.push(server);
    await server.start();

    const offlineUserId = "offline-member";
    store.upsertHubUser({
      id: offlineUserId,
      username: "offline-user",
      deviceName: "Offline Mac",
      role: "member",
      status: "active",
      groups: [],
      tokenHash: "hash",
      createdAt: 1,
      approvedAt: 1,
    });
    store.updateHubUserActivity(offlineUserId, "127.0.0.1", Date.now() - 11 * 60 * 1000);
    store.upsertHubMemory({
      id: "offline-memory-1",
      sourceChunkId: "offline-chunk-1",
      sourceUserId: offlineUserId,
      sourceAgent: "",
      role: "assistant",
      content: "offline memory content",
      summary: "offline memory",
      kind: "paragraph",
      groupId: null,
      visibility: "public",
      createdAt: 1,
      updatedAt: 1,
    });
    store.upsertHubTask({
      id: "offline-task-1",
      sourceTaskId: "offline-task-source-1",
      sourceUserId: offlineUserId,
      title: "offline task",
      summary: "offline task summary",
      groupId: null,
      visibility: "public",
      createdAt: 1,
      updatedAt: 1,
    });
    store.upsertHubSkill({
      id: "offline-skill-1",
      sourceSkillId: "offline-skill-source-1",
      sourceUserId: offlineUserId,
      name: "offline skill",
      description: "offline skill description",
      version: 1,
      groupId: null,
      visibility: "public",
      bundle: JSON.stringify({ skill_md: "# Offline Skill", scripts: [], references: [], evals: [] }),
      qualityScore: 0.8,
      createdAt: 1,
      updatedAt: 1,
    });

    (server as any).checkOfflineUsers();

    expect(store.getHubMemoryBySource(offlineUserId, "offline-chunk-1")).not.toBeNull();
    expect(store.getHubTaskBySource(offlineUserId, "offline-task-source-1")).not.toBeNull();
    expect(store.getHubSkillBySource(offlineUserId, "offline-skill-source-1")).not.toBeNull();
  });
});

describe("hub search pipeline", () => {
  it("should scope search/detail and ignore spoofed sourceUserId", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-scope-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "test.db"), noopLog);
    stores.push(store);

    const server = new HubServer({
      store,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18916, teamName: "Scope", teamToken: "scope-secret" } } },
      dataDir: dir,
    } as any);
    servers.push(server);
    await server.start();

    const authPath = path.join(dir, "hub-auth.json");
    const adminState = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const adminToken = adminState.bootstrapAdminToken;

    const joinA = await fetch("http://127.0.0.1:18916/api/v1/hub/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", deviceName: "A", teamToken: "scope-secret" }) });
    const joinB = await fetch("http://127.0.0.1:18916/api/v1/hub/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "bob", deviceName: "B", teamToken: "scope-secret" }) });
    const userA = await joinA.json();
    const userB = await joinB.json();

    const approveA = await fetch("http://127.0.0.1:18916/api/v1/hub/admin/approve-user", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ userId: userA.userId, username: "alice" }) });
    const approveB = await fetch("http://127.0.0.1:18916/api/v1/hub/admin/approve-user", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ userId: userB.userId, username: "bob" }) });
    const tokenA = (await approveA.json()).token;
    const tokenB = (await approveB.json()).token;

    store.upsertHubGroup({ id: "group-1", name: "Backend", description: "backend", createdAt: 1 });
    store.addHubGroupMember("group-1", userA.userId, 1);

    const shareA = await fetch("http://127.0.0.1:18916/api/v1/hub/tasks/share", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        task: { id: "hub-task-a", sourceTaskId: "task-a", sourceUserId: "spoof-user", title: "Group Task", summary: "group summary", groupId: "group-1", visibility: "group", createdAt: 1, updatedAt: 1 },
        chunks: [{ id: "hub-chunk-a", hubTaskId: "hub-task-a", sourceTaskId: "task-a", sourceChunkId: "chunk-a", sourceUserId: "spoof-user", role: "assistant", content: "secret backend nginx config", summary: "secret backend nginx", kind: "paragraph", createdAt: 2 }],
      }),
    });
    expect(shareA.status).toBe(200);
    const storedTask = store.getHubTaskBySource(userA.userId, "task-a");
    expect(storedTask).not.toBeNull();

    const searchA = await fetch("http://127.0.0.1:18916/api/v1/hub/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ query: "backend nginx", maxResults: 5 }) });
    const searchB = await fetch("http://127.0.0.1:18916/api/v1/hub/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenB}` }, body: JSON.stringify({ query: "backend nginx", maxResults: 5 }) });
    const jsonA = await searchA.json();
    const jsonB = await searchB.json();
    expect(jsonA.hits.length).toBeGreaterThan(0);
    expect(jsonB.hits).toEqual([]);

    const detailA = await fetch("http://127.0.0.1:18916/api/v1/hub/memory-detail", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ remoteHitId: jsonA.hits[0].remoteHitId }) });
    expect(detailA.status).toBe(200);
    const detailB = await fetch("http://127.0.0.1:18916/api/v1/hub/memory-detail", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenB}` }, body: JSON.stringify({ remoteHitId: jsonA.hits[0].remoteHitId }) });
    expect([403, 404]).toContain(detailB.status);
  });

  it("should not return vector-only hits for unauthorized group chunks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-vector-scope-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "test.db"), noopLog);
    stores.push(store);

    const embedder = {
      embed: async (_texts: string[]) => [new Float32Array([1, 0])],
    } as any;

    const server = new HubServer({
      store,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18919, teamName: "VectorScope", teamToken: "vector-secret" } } },
      dataDir: dir,
      embedder,
    } as any);
    servers.push(server);
    await server.start();

    const authPath = path.join(dir, "hub-auth.json");
    const adminState = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const adminToken = adminState.bootstrapAdminToken;

    const joinA = await fetch("http://127.0.0.1:18919/api/v1/hub/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", deviceName: "A", teamToken: "vector-secret" }) });
    const joinB = await fetch("http://127.0.0.1:18919/api/v1/hub/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "bob", deviceName: "B", teamToken: "vector-secret" }) });
    const userA = await joinA.json();
    const userB = await joinB.json();

    const approveA = await fetch("http://127.0.0.1:18919/api/v1/hub/admin/approve-user", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ userId: userA.userId, username: "alice" }) });
    const approveB = await fetch("http://127.0.0.1:18919/api/v1/hub/admin/approve-user", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ userId: userB.userId, username: "bob" }) });
    const tokenA = (await approveA.json()).token;
    const tokenB = (await approveB.json()).token;

    store.upsertHubGroup({ id: "group-secret", name: "Secret", description: "secret", createdAt: 1 });
    store.addHubGroupMember("group-secret", userA.userId, 1);
    store.upsertHubTask({ id: "hub-task-secret", sourceTaskId: "task-secret", sourceUserId: userA.userId, title: "Secret Task", summary: "vector-only secret", groupId: "group-secret", visibility: "group", createdAt: 1, updatedAt: 1 });
    store.upsertHubChunk({ id: "hub-chunk-secret", hubTaskId: "hub-task-secret", sourceTaskId: "task-secret", sourceChunkId: "chunk-secret", sourceUserId: userA.userId, role: "assistant", content: "forbidden rollout payload", summary: "forbidden rollout payload", kind: "paragraph", createdAt: 2 });
    store.upsertHubEmbedding("hub-chunk-secret", new Float32Array([1, 0]));

    const searchA = await fetch("http://127.0.0.1:18919/api/v1/hub/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ query: "nonsensequery", maxResults: 5 }) });
    const searchB = await fetch("http://127.0.0.1:18919/api/v1/hub/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenB}` }, body: JSON.stringify({ query: "nonsensequery", maxResults: 5 }) });
    const jsonA = await searchA.json();
    const jsonB = await searchB.json();

    expect(jsonA.hits.length).toBeGreaterThan(0);
    expect(jsonB.hits).toEqual([]);
  });

  it("should accept shared task content and return searchable hits with details", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-search-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "test.db"), noopLog);
    stores.push(store);

    const server = new HubServer({
      store,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18915, teamName: "Search", teamToken: "search-secret" } } },
      dataDir: dir,
    } as any);
    servers.push(server);
    await server.start();

    const authPath = path.join(dir, "hub-auth.json");
    const state = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const token = state.bootstrapAdminToken;

    const shareRes = await fetch("http://127.0.0.1:18915/api/v1/hub/tasks/share", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        task: {
          id: "hub-task-1",
          sourceTaskId: "task-1",
          sourceUserId: "user-1",
          title: "Deploy Nginx",
          summary: "deploy nginx summary",
          groupId: null,
          visibility: "public",
          createdAt: 1,
          updatedAt: 1,
        },
        chunks: [
          {
            id: "hub-chunk-1",
            hubTaskId: "hub-task-1",
            sourceTaskId: "task-1",
            sourceChunkId: "chunk-1",
            sourceUserId: "user-1",
            role: "assistant",
            content: "Use nginx upstream and proxy_pass to port 3000",
            summary: "nginx upstream to port 3000",
            kind: "paragraph",
            createdAt: 2,
          },
        ],
      }),
    });
    expect(shareRes.status).toBe(200);

    const searchRes = await fetch("http://127.0.0.1:18915/api/v1/hub/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: "nginx upstream 3000", scope: "all", maxResults: 5 }),
    });
    expect(searchRes.status).toBe(200);
    const searchJson = await searchRes.json();
    expect(searchJson.hits.length).toBeGreaterThan(0);
    expect(searchJson.hits[0].remoteHitId).toBeTruthy();
    expect(searchJson.hits[0].taskTitle).toBe("Deploy Nginx");

    const detailRes = await fetch("http://127.0.0.1:18915/api/v1/hub/memory-detail", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ remoteHitId: searchJson.hits[0].remoteHitId }),
    });
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    expect(detailJson.content).toContain("proxy_pass");
  });
});


describe("hub skill pipeline", () => {
  it("should publish, fetch, and unpublish skill bundles", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-skills-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "test.db"), noopLog);
    stores.push(store);

    const server = new HubServer({
      store,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18918, teamName: "Skills", teamToken: "skills-secret" } } },
      dataDir: dir,
    } as any);
    servers.push(server);
    await server.start();

    const authPath = path.join(dir, "hub-auth.json");
    const state = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const token = state.bootstrapAdminToken;
    const userId = state.bootstrapAdminUserId;

    const publishRes = await fetch("http://127.0.0.1:18918/api/v1/hub/skills/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        visibility: "public",
        metadata: {
          id: "skill-source-1",
          name: "docker-compose-deploy",
          description: "Deploy with docker compose",
          version: 2,
          qualityScore: 0.88,
        },
        bundle: {
          skill_md: "# Docker Compose Deploy\nUse scripts/deploy.sh",
          scripts: [{ filename: "deploy.sh", content: "#!/bin/bash\ndocker compose up -d\n" }],
          references: [{ filename: "docker-compose.yml", content: "services:\n  app: {}\n" }],
          evals: [{ id: 1, prompt: "deploy app", expectations: ["compose", "up -d"] }],
        },
      }),
    });
    expect(publishRes.status).toBe(200);
    const publishJson = await publishRes.json();
    expect(publishJson.skillId).toBeTruthy();

    const stored = store.getHubSkillBySource(userId, "skill-source-1");
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe("docker-compose-deploy");

    const bundleRes = await fetch(`http://127.0.0.1:18918/api/v1/hub/skills/${publishJson.skillId}/bundle`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bundleRes.status).toBe(200);
    const bundleJson = await bundleRes.json();
    expect(bundleJson.metadata.name).toBe("docker-compose-deploy");
    expect(bundleJson.bundle.skill_md).toContain("Docker Compose Deploy");

    const unpublishRes = await fetch("http://127.0.0.1:18918/api/v1/hub/skills/unpublish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sourceSkillId: "skill-source-1" }),
    });
    expect(unpublishRes.status).toBe(200);
    expect(store.getHubSkillBySource(userId, "skill-source-1")).toBeNull();
  });
});
