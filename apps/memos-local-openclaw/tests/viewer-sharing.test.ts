import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { ViewerServer } from "../src/viewer/server";
import { HubServer } from "../src/hub/server";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let tmpDirs: string[] = [];
let stores: SqliteStore[] = [];
let viewer: ViewerServer | null = null;
let hub: HubServer | null = null;

async function viewerAuthCookie(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "passw0rd" }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0];
}

afterEach(async () => {
  viewer?.stop();
  viewer = null;
  await hub?.stop();
  hub = null;
  for (const store of stores.splice(0)) store.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("viewer sharing endpoints", () => {
  it("serves sharing status and admin pending users", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-sharing-hub-"));
    const viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-sharing-viewer-"));
    tmpDirs.push(hubDir, viewerDir);

    const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog);
    const viewerStore = new SqliteStore(path.join(viewerDir, "viewer.db"), noopLog);
    stores.push(hubStore, viewerStore);

    hub = new HubServer({
      store: hubStore,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 19831, teamName: "Viewer Team", teamToken: "viewer-secret" } } } as any,
      dataDir: hubDir,
    } as any);
    await hub.start();

    const authState = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
    const adminToken = authState.bootstrapAdminToken as string;

    const join = await fetch("http://127.0.0.1:19831/api/v1/hub/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", deviceName: "Bob Mac", teamToken: "viewer-secret" }),
    });
    const joinJson = await join.json();
    expect(join.status).toBe(200);
    expect(joinJson.status).toBe("pending");
    expect(joinJson.userId).toBeTruthy();

    const approveBob = await fetch("http://127.0.0.1:19831/api/v1/hub/admin/approve-user", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userId: joinJson.userId, username: "bob" }),
    });
    expect(approveBob.status).toBe(200);
    const bobToken = (await approveBob.json()).token;
    expect(bobToken).toBeTruthy();

    viewer = new ViewerServer({
      store: viewerStore,
      embedder: { provider: "local", embedQuery: async () => { throw new Error("skip vec"); } } as any,
      port: 19832,
      log: noopLog,
      dataDir: viewerDir,
      ctx: {
        stateDir: viewerDir,
        workspaceDir: viewerDir,
        config: {
          sharing: { enabled: true, role: "client", client: { hubAddress: "127.0.0.1:19831", userToken: adminToken } },
        } as any,
        log: noopLog,
      },
    });
    const viewerUrl = await viewer.start();
    const cookie = await viewerAuthCookie(viewerUrl);

    const statusRes = await fetch(`${viewerUrl}/api/sharing/status`, { headers: { cookie } });
    const statusJson = await statusRes.json();
    expect(statusJson.enabled).toBe(true);
    expect(statusJson.connection.connected).toBe(true);
    expect(statusJson.connection.user.role).toBe("admin");
    expect(statusJson.admin.canManageUsers).toBe(true);
    expect(statusJson.admin.rejectSupported).toBe(true);

    const pendingRes = await fetch(`${viewerUrl}/api/sharing/pending-users`, { headers: { cookie } });
    const pendingJson = await pendingRes.json();
    expect(pendingJson.users.length).toBe(0);

    const joinEve = await fetch("http://127.0.0.1:19831/api/v1/hub/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "eve", deviceName: "Eve Mac", teamToken: "viewer-secret" }),
    });
    const eveJson = await joinEve.json();
    expect(joinEve.status).toBe(200);
    expect(eveJson.status).toBe("pending");
    expect(eveJson.userId).toBeTruthy();
  });

  it("serves split sharing memory and skill search payloads", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-search-hub-"));
    const viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-search-viewer-"));
    tmpDirs.push(hubDir, viewerDir);

    const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog);
    const viewerStore = new SqliteStore(path.join(viewerDir, "viewer.db"), noopLog);
    stores.push(hubStore, viewerStore);

    hub = new HubServer({
      store: hubStore,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 19833, teamName: "Viewer Search", teamToken: "viewer-search-secret" } } } as any,
      dataDir: hubDir,
    } as any);
    await hub.start();

    const authState = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
    const adminToken = authState.bootstrapAdminToken as string;
    const adminUserId = authState.bootstrapAdminUserId as string;

    hubStore.upsertHubTask({ id: "hub-task-1", sourceTaskId: "task-1", sourceUserId: adminUserId, title: "Hub rollout", summary: "Hub rollout", groupId: null, visibility: "public", createdAt: 1, updatedAt: 1 });
    hubStore.upsertHubChunk({ id: "hub-chunk-1", hubTaskId: "hub-task-1", sourceTaskId: "task-1", sourceChunkId: "chunk-1", sourceUserId: adminUserId, role: "assistant", content: "Hub rollout checklist with nginx canary.", summary: "Hub rollout checklist", kind: "paragraph", createdAt: 2 });
    hubStore.upsertHubSkill({ id: "hub-skill-1", sourceSkillId: "skill-1", sourceUserId: adminUserId, name: "nginx-rollout", description: "Rollout nginx safely", version: 1, groupId: null, visibility: "public", bundle: JSON.stringify({ skill_md: "# Nginx Rollout", scripts: [], references: [], evals: [] }), qualityScore: 0.9, createdAt: 1, updatedAt: 1 });

    viewerStore.insertTask({ id: "local-task-1", sessionKey: "local-session", title: "Local rollout", summary: "Local rollout", status: "completed", owner: "agent:main", startedAt: 1, endedAt: 2, updatedAt: 2 });
    viewerStore.insertChunk({ id: "local-chunk-1", sessionKey: "local-session", turnId: "turn-1", seq: 0, role: "assistant", content: "Local rollout checklist with smoke test.", kind: "paragraph", summary: "Local rollout checklist", embedding: null, taskId: "local-task-1", skillId: null, owner: "agent:main", dedupStatus: "active", dedupTarget: null, dedupReason: null, mergeCount: 0, lastHitAt: null, mergeHistory: "[]", createdAt: 3, updatedAt: 3 });
    viewerStore.insertSkill({ id: "local-skill-1", name: "local-rollout", description: "Local rollout helper", version: 1, status: "active", tags: "[]", sourceType: "manual", dirPath: viewerDir, installed: 0, owner: "agent:main", visibility: "private", qualityScore: 0.8, createdAt: 1, updatedAt: 1 });

    viewer = new ViewerServer({
      store: viewerStore,
      embedder: { provider: "local", embedQuery: async () => { throw new Error("skip vec"); } } as any,
      port: 19834,
      log: noopLog,
      dataDir: viewerDir,
      ctx: {
        stateDir: viewerDir,
        workspaceDir: viewerDir,
        config: {
          sharing: { enabled: true, role: "client", client: { hubAddress: "127.0.0.1:19833", userToken: adminToken } },
        } as any,
        log: noopLog,
      },
    });
    const viewerUrl = await viewer.start();
    const cookie = await viewerAuthCookie(viewerUrl);

    const memRes = await fetch(`${viewerUrl}/api/sharing/search/memories`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ query: "rollout checklist", scope: "all", maxResults: 5 }),
    });
    const memJson = await memRes.json();
    expect(memJson.local.hits.length).toBeGreaterThan(0);
    expect(memJson.hub.hits.length).toBeGreaterThan(0);

    const detailRes = await fetch(`${viewerUrl}/api/sharing/memory-detail`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ remoteHitId: memJson.hub.hits[0].remoteHitId }),
    });
    const detailJson = await detailRes.json();
    expect(detailJson.summary).toContain("Hub rollout checklist");
    expect(detailJson.content).toContain("nginx canary");

    const skillRes = await fetch(`${viewerUrl}/api/sharing/search/skills?query=rollout&scope=all`, { headers: { cookie } });
    const skillJson = await skillRes.json();
    expect(skillJson.local.hits.length).toBeGreaterThan(0);
    expect(skillJson.hub.hits.length).toBeGreaterThan(0);

    const shareTaskRes = await fetch(`${viewerUrl}/api/sharing/tasks/share`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "local-task-1", visibility: "public" }),
    });
    const shareTaskJson = await shareTaskRes.json();
    expect(shareTaskJson.ok).toBe(true);
    expect(hubStore.getHubTaskBySource(adminUserId, "local-task-1")).not.toBeNull();
    expect(viewerStore.getLocalSharedTask("local-task-1")?.hubTaskId).toBeTruthy();

    const taskDetailRes = await fetch(`${viewerUrl}/api/task/local-task-1`, { headers: { cookie } });
    const taskDetailJson = await taskDetailRes.json();
    expect(taskDetailJson.sharingVisibility).toBe("public");

    const shareMemoryRes = await fetch(`${viewerUrl}/api/sharing/memories/share`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ chunkId: "local-chunk-1", visibility: "public" }),
    });
    const shareMemoryJson = await shareMemoryRes.json();
    expect(shareMemoryJson.ok).toBe(true);
    expect(viewerStore.getTeamSharedChunk("local-chunk-1")?.hubMemoryId).toBeTruthy();

    const memoryListRes = await fetch(`${viewerUrl}/api/memories?limit=10`, { headers: { cookie } });
    const memoryListJson = await memoryListRes.json();
    const memoryRow = memoryListJson.memories.find((m: any) => m.id === "local-chunk-1");
    expect(memoryRow?.sharingVisibility).toBe("public");

    const shareSkillRes = await fetch(`${viewerUrl}/api/sharing/skills/share`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ skillId: "local-skill-1", visibility: "public" }),
    });
    const shareSkillJson = await shareSkillRes.json();
    expect(shareSkillJson.ok).toBe(true);
    expect(viewerStore.getTeamSharedSkill("local-skill-1")?.hubSkillId).toBeTruthy();

    const skillDetailRes = await fetch(`${viewerUrl}/api/skill/local-skill-1`, { headers: { cookie } });
    const skillDetailJson = await skillDetailRes.json();
    expect(skillDetailJson.skill.sharingVisibility).toBe("public");

    const pullRes = await fetch(`${viewerUrl}/api/sharing/skills/pull`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ skillId: skillJson.hub.hits[0].skillId }),
    });
    const pullJson = await pullRes.json();
    expect(pullJson.ok).toBe(true);
    expect(viewerStore.getSkill(pullJson.localSkillId)).not.toBeNull();

    const unshareTaskRes = await fetch(`${viewerUrl}/api/sharing/tasks/unshare`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "local-task-1" }),
    });
    const unshareTaskJson = await unshareTaskRes.json();
    expect(unshareTaskJson.ok).toBe(true);
    expect(hubStore.getHubTaskBySource(adminUserId, "local-task-1")).toBeNull();
    expect(viewerStore.getLocalSharedTask("local-task-1")).toBeNull();

    const unshareMemoryRes = await fetch(`${viewerUrl}/api/sharing/memories/unshare`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ chunkId: "local-chunk-1" }),
    });
    const unshareMemoryJson = await unshareMemoryRes.json();
    expect(unshareMemoryJson.ok).toBe(true);
    expect(viewerStore.getTeamSharedChunk("local-chunk-1")).toBeNull();

    const unshareSkillRes = await fetch(`${viewerUrl}/api/sharing/skills/unshare`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ skillId: "local-skill-1" }),
    });
    const unshareSkillJson = await unshareSkillRes.json();
    expect(unshareSkillJson.ok).toBe(true);
    expect(viewerStore.getTeamSharedSkill("local-skill-1")).toBeNull();
  });


  it("degrades to local-only results when hub is unreachable", async () => {
    const viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-offline-"));
    tmpDirs.push(viewerDir);

    const viewerStore = new SqliteStore(path.join(viewerDir, "viewer.db"), noopLog);
    stores.push(viewerStore);

    viewerStore.insertTask({ id: "offline-task-1", sessionKey: "offline-session", title: "Offline task", summary: "Offline task", status: "completed", owner: "agent:main", startedAt: 1, endedAt: 2, updatedAt: 2 });
    viewerStore.insertChunk({ id: "offline-chunk-1", sessionKey: "offline-session", turnId: "turn-1", seq: 0, role: "assistant", content: "Offline local nginx checklist remains searchable.", kind: "paragraph", summary: "Offline nginx checklist", embedding: null, taskId: "offline-task-1", skillId: null, owner: "agent:main", dedupStatus: "active", dedupTarget: null, dedupReason: null, mergeCount: 0, lastHitAt: null, mergeHistory: "[]", createdAt: 3, updatedAt: 3 });
    viewerStore.insertSkill({ id: "offline-skill-1", name: "offline-rollout", description: "Offline local rollout helper", version: 1, status: "active", tags: "[]", sourceType: "manual", dirPath: viewerDir, installed: 0, owner: "agent:main", visibility: "private", qualityScore: 0.8, createdAt: 1, updatedAt: 1 });

    viewer = new ViewerServer({
      store: viewerStore,
      embedder: { provider: "local", embedQuery: async () => { throw new Error("skip vec"); } } as any,
      port: 19835,
      log: noopLog,
      dataDir: viewerDir,
      ctx: {
        stateDir: viewerDir,
        workspaceDir: viewerDir,
        config: {
          sharing: { enabled: true, role: "client", client: { hubAddress: "127.0.0.1:19999", userToken: "bad-token" } },
        } as any,
        log: noopLog,
      },
    });
    const viewerUrl = await viewer.start();
    const cookie = await viewerAuthCookie(viewerUrl);

    const statusRes = await fetch(`${viewerUrl}/api/sharing/status`, { headers: { cookie } });
    const statusJson = await statusRes.json();
    expect(statusJson.connection.connected).toBe(false);

    const pendingRes = await fetch(`${viewerUrl}/api/sharing/pending-users`, { headers: { cookie } });
    const pendingJson = await pendingRes.json();
    expect(pendingJson.error).toBeTruthy();

    const memRes = await fetch(`${viewerUrl}/api/sharing/search/memories`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ query: "nginx checklist", scope: "all", maxResults: 5 }),
    });
    const memJson = await memRes.json();
    expect(memJson.local.hits.length).toBeGreaterThan(0);
    expect(memJson.hub.hits.length).toBe(0);
    expect(memJson.error).toBeTruthy();

    const skillRes = await fetch(`${viewerUrl}/api/sharing/search/skills?query=rollout&scope=all`, { headers: { cookie } });
    const skillJson = await skillRes.json();
    expect(skillJson.local.hits.length).toBeGreaterThan(0);
    expect(skillJson.hub.hits.length).toBe(0);
    expect(skillJson.error).toBeTruthy();
  });

});
