import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { TraceDTO } from "../../../agent-contract/dto.js";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../../../core/config/index.js";
import { HubClientRuntime } from "../../../core/hub/client.js";
import { createHubRuntime } from "../../../core/hub/runtime.js";
import { HubServerRuntime } from "../../../core/hub/server.js";
import { rootLogger } from "../../../core/logger/index.js";
import { HUB_SHARED_MEMORY_TOMBSTONE_TTL_MS } from "../../../core/storage/repos/hub.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

describe("hub runtime", () => {
  const handles: TmpDbHandle[] = [];
  const servers: HubServerRuntime[] = [];
  const clients: HubClientRuntime[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.stop()));
    await Promise.all(servers.map((s) => s.stop()));
    while (handles.length) handles.pop()!.cleanup();
    clients.length = 0;
    servers.length = 0;
  });

  it("accepts a client join request and activates it after approval", async () => {
    const hubDb = makeTmpDb({ agent: "openclaw" });
    const clientDb = makeTmpDb({ agent: "hermes" });
    handles.push(hubDb, clientDb);

    const port = await freePort();
    const teamToken = "test-team-token";
    const hubConfig = configWithHub({
      enabled: true,
      role: "hub",
      port,
      teamName: "Runtime Test",
      teamToken,
    });
    const hub = new HubServerRuntime({
      repo: hubDb.repos.hub,
      config: hubConfig,
      log: rootLogger.child({ channel: "test.hub.server" }),
      version: "test",
    });
    servers.push(hub);
    const snapshot = await hub.start();

    const clientConfig = configWithHub({
      enabled: true,
      role: "client",
      address: snapshot.url,
      teamToken,
      nickname: "alice",
    });
    const client = new HubClientRuntime({
      repo: clientDb.repos.hub,
      config: clientConfig,
      log: rootLogger.child({ channel: "test.hub.client" }),
    });
    clients.push(client);

    const pendingConnection = await client.start();
    expect(pendingConnection?.lastKnownStatus).toBe("pending");
    expect(pendingConnection?.userToken).toBe("");
    const pending = hubDb.repos.hub.listUsers("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.username).toBe("alice");

    const approved = hub.approveUser(pending[0]!.id);
    expect(approved?.token).toBeTruthy();

    const refreshed = await client.refreshStatus();
    expect(refreshed.connected).toBe(true);
    expect(refreshed.user).toMatchObject({ id: pending[0]!.id, username: "alice", status: "active" });
    expect(clientDb.repos.hub.getClientConnection()?.lastKnownStatus).toBe("active");

    const connected = await client.start();
    expect(connected?.userToken).toBeTruthy();
    expect(connected?.lastKnownStatus).toBe("active");

    const me = await client.requestJson<Record<string, unknown>>("/api/v1/hub/me", { method: "GET" });
    expect(me).toMatchObject({ id: pending[0]!.id, username: "alice", status: "active" });
  });

  it("falls back to team-token join when a legacy user token is rejected", async () => {
    const hubDb = makeTmpDb({ agent: "hermes" });
    const clientDb = makeTmpDb({ agent: "openclaw" });
    handles.push(hubDb, clientDb);

    const port = await freePort();
    const teamToken = "fallback-team-token";
    const hub = new HubServerRuntime({
      repo: hubDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "hub",
        port,
        teamName: "Fallback Test",
        teamToken,
      }),
      log: rootLogger.child({ channel: "test.hub.server" }),
      version: "test",
    });
    servers.push(hub);
    const snapshot = await hub.start();

    const client = new HubClientRuntime({
      repo: clientDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "client",
        address: snapshot.url,
        teamToken,
        userToken: "stale-token-from-old-config",
        nickname: "openclaw",
      }),
      log: rootLogger.child({ channel: "test.hub.client" }),
    });
    clients.push(client);

    const pendingConnection = await client.start();
    expect(pendingConnection?.lastKnownStatus).toBe("pending");
    expect(pendingConnection?.userToken).toBe("");
    expect(hubDb.repos.hub.listUsers("pending").map((u) => u.username)).toEqual(["openclaw"]);
  });

  it("does not keep showing connected when the configured team token changes", async () => {
    const hubDb = makeTmpDb({ agent: "hermes" });
    const clientDb = makeTmpDb({ agent: "openclaw" });
    handles.push(hubDb, clientDb);

    const port = await freePort();
    const teamToken = "correct-team-token";
    const hub = new HubServerRuntime({
      repo: hubDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "hub",
        port,
        teamName: "Token Rotation Test",
        teamToken,
      }),
      log: rootLogger.child({ channel: "test.hub.server" }),
      version: "test",
    });
    servers.push(hub);
    const snapshot = await hub.start();

    const client = new HubClientRuntime({
      repo: clientDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "client",
        address: snapshot.url,
        teamToken,
        nickname: "openclaw",
      }),
      log: rootLogger.child({ channel: "test.hub.client" }),
    });
    clients.push(client);

    await client.start();
    const pending = hubDb.repos.hub.listUsers("pending");
    expect(pending).toHaveLength(1);
    hub.approveUser(pending[0]!.id);
    expect((await client.refreshStatus()).connected).toBe(true);
    expect(clientDb.repos.hub.getClientConnection()?.userToken).toBeTruthy();

    const wrongTokenClient = new HubClientRuntime({
      repo: clientDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "client",
        address: snapshot.url,
        teamToken: "wrong-team-token",
        nickname: "openclaw",
      }),
      log: rootLogger.child({ channel: "test.hub.client.wrong_token" }),
    });
    clients.push(wrongTokenClient);

    await expect(wrongTokenClient.start()).rejects.toThrow("invalid_team_token");
    const connAfterWrongToken = clientDb.repos.hub.getClientConnection();
    expect(connAfterWrongToken?.lastKnownStatus).toBe("invalid_team_token");
    expect(connAfterWrongToken?.userToken).toBe("");
    expect((await wrongTokenClient.refreshStatus()).connected).toBe(false);
  });

  it("syncs personal nickname changes and uses nickname as the join identity", async () => {
    const hubDb = makeTmpDb({ agent: "hermes" });
    const clientDb = makeTmpDb({ agent: "openclaw" });
    const secondClientDb = makeTmpDb({ agent: "cursor" });
    handles.push(hubDb, clientDb, secondClientDb);

    const port = await freePort();
    const teamToken = "nickname-team-token";
    const hub = new HubServerRuntime({
      repo: hubDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "hub",
        port,
        teamName: "Nickname Test",
        teamToken,
      }),
      log: rootLogger.child({ channel: "test.hub.server" }),
      version: "test",
    });
    servers.push(hub);
    const snapshot = await hub.start();

    const client = new HubClientRuntime({
      repo: clientDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "client",
        address: snapshot.url,
        teamToken,
        nickname: "alice",
      }),
      log: rootLogger.child({ channel: "test.hub.client" }),
    });
    clients.push(client);

    await client.start();
    const pending = hubDb.repos.hub.listUsers("pending");
    expect(pending).toHaveLength(1);
    hub.approveUser(pending[0]!.id);
    expect((await client.refreshStatus()).connected).toBe(true);

    const renamedClient = new HubClientRuntime({
      repo: clientDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "client",
        address: snapshot.url,
        teamToken,
        nickname: "alice-renamed",
      }),
      log: rootLogger.child({ channel: "test.hub.client.renamed" }),
    });
    clients.push(renamedClient);

    const renamedConnection = await renamedClient.start();
    expect(renamedConnection?.username).toBe("alice-renamed");
    expect(hubDb.repos.hub.getUser(pending[0]!.id)?.username).toBe("alice-renamed");
    expect((await renamedClient.refreshStatus()).user).toMatchObject({ username: "alice-renamed" });

    const secondClient = new HubClientRuntime({
      repo: secondClientDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "client",
        address: snapshot.url,
        teamToken,
        nickname: "alice-renamed",
      }),
      log: rootLogger.child({ channel: "test.hub.client.second" }),
    });
    clients.push(secondClient);

    const secondConnection = await secondClient.start();
    expect(secondConnection?.lastKnownStatus).toBe("active");
    expect(secondConnection?.userId).toBe(pending[0]!.id);
    expect(hubDb.repos.hub.listUsers().filter((u) => u.username === "alice-renamed")).toHaveLength(1);
  });

  it("removes approved users from the hub and invalidates the client status", async () => {
    const hubDb = makeTmpDb({ agent: "hermes" });
    const clientDb = makeTmpDb({ agent: "openclaw" });
    handles.push(hubDb, clientDb);

    const port = await freePort();
    const teamToken = "remove-team-token";
    const hub = new HubServerRuntime({
      repo: hubDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "hub",
        port,
        teamName: "Remove Test",
        teamToken,
      }),
      log: rootLogger.child({ channel: "test.hub.server" }),
      version: "test",
    });
    servers.push(hub);
    const snapshot = await hub.start();

    const client = new HubClientRuntime({
      repo: clientDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "client",
        address: snapshot.url,
        teamToken,
        nickname: "delete-me",
      }),
      log: rootLogger.child({ channel: "test.hub.client" }),
    });
    clients.push(client);

    await client.start();
    const pending = hubDb.repos.hub.listUsers("pending");
    hub.approveUser(pending[0]!.id);
    expect((await client.refreshStatus()).connected).toBe(true);

    const removed = hub.removeUser(pending[0]!.id);
    expect(removed?.status).toBe("removed");
    const afterRemove = await client.refreshStatus();
    expect(afterRemove.connected).toBe(false);
    expect(afterRemove.user).toMatchObject({ status: "removed" });
  });

  it("does not create a pending member when the first join uses a wrong team token", async () => {
    const hubDb = makeTmpDb({ agent: "hermes" });
    const clientDb = makeTmpDb({ agent: "openclaw" });
    handles.push(hubDb, clientDb);

    const port = await freePort();
    const hub = new HubServerRuntime({
      repo: hubDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "hub",
        port,
        teamName: "Wrong Token Test",
        teamToken: "correct-team-token",
      }),
      log: rootLogger.child({ channel: "test.hub.server" }),
      version: "test",
    });
    servers.push(hub);
    const snapshot = await hub.start();

    const client = new HubClientRuntime({
      repo: clientDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "client",
        address: snapshot.url,
        teamToken: "wrong-team-token",
        nickname: "openclaw",
      }),
      log: rootLogger.child({ channel: "test.hub.client" }),
    });
    clients.push(client);

    await expect(client.start()).rejects.toThrow("invalid_team_token");
    expect(hubDb.repos.hub.listUsers("pending")).toHaveLength(0);
    expect(clientDb.repos.hub.getClientConnection()).toBeNull();
  });

  it("keeps client snapshots status-only and hub snapshots admin-only", async () => {
    const hubDb = makeTmpDb({ agent: "hermes" });
    const clientDb = makeTmpDb({ agent: "openclaw" });
    handles.push(hubDb, clientDb);

    const port = await freePort();
    const teamToken = "snapshot-team-token";
    const hubRuntime = createHubRuntime({
      repos: hubDb.repos,
      config: configWithHub({
        enabled: true,
        role: "hub",
        port,
        teamName: "Snapshot Test",
        teamToken,
      }),
      log: rootLogger.child({ channel: "test.hub.runtime" }),
      agent: "hermes",
      version: "test",
    });
    servers.push({
      stop: () => hubRuntime.stop(),
    } as HubServerRuntime);
    await hubRuntime.start();
    const hubSnapshot = await hubRuntime.adminSnapshot();
    const url = hubSnapshot.url!;

    const clientRuntime = createHubRuntime({
      repos: clientDb.repos,
      config: configWithHub({
        enabled: true,
        role: "client",
        address: url,
        teamToken,
        nickname: "openclaw",
      }),
      log: rootLogger.child({ channel: "test.client.runtime" }),
      agent: "openclaw",
      version: "test",
    });
    await clientRuntime.start();

    const clientSnapshot = await clientRuntime.adminSnapshot();
    expect(clientSnapshot.role).toBe("client");
    expect(clientSnapshot.status).toBe("pending");
    expect(clientSnapshot.pending).toEqual([]);
    expect(clientSnapshot.users).toHaveLength(1);
    expect(clientSnapshot.users?.[0]).toMatchObject({ name: "openclaw", connected: false, status: "pending" });

    const hubSnapshotWithPending = await hubRuntime.adminSnapshot();
    expect(hubSnapshotWithPending.role).toBe("hub");
    expect(hubSnapshotWithPending.pending?.map((u) => u.name)).toEqual(["openclaw"]);
    await clientRuntime.stop();
  });

  it("searches team hub memories from a joined client without importing local traces", async () => {
    const hubDb = makeTmpDb({ agent: "hermes" });
    const clientDb = makeTmpDb({ agent: "openclaw" });
    handles.push(hubDb, clientDb);

    const port = await freePort();
    const teamToken = "hub-search-team-token";
    const hubRuntime = createHubRuntime({
      repos: hubDb.repos,
      config: configWithHub({
        enabled: true,
        role: "hub",
        port,
        teamName: "Hub Search Test",
        teamToken,
      }),
      log: rootLogger.child({ channel: "test.hub.search.runtime" }),
      agent: "hermes",
      version: "test",
    });
    servers.push({ stop: () => hubRuntime.stop() } as HubServerRuntime);
    await hubRuntime.start();
    await hubRuntime.publishTrace({
      id: "tr-book",
      episodeId: "ep-book",
      sessionId: "sess-book",
      ts: Date.now(),
      ownerAgentKind: "hermes",
      ownerProfileId: "default",
      userText: "我喜欢看的书是《百年孤独》",
      agentText: "记住了：你喜欢看的书是《百年孤独》。",
      summary: "喜欢看的书是《百年孤独》",
      toolCalls: [],
      value: 0,
      alpha: 0,
      priority: 0.5,
    } as TraceDTO, new Float32Array([0.1, 0.9]));

    const hubSnapshot = await hubRuntime.adminSnapshot();
    const clientRuntime = createHubRuntime({
      repos: clientDb.repos,
      config: configWithHub({
        enabled: true,
        role: "client",
        address: hubSnapshot.url!,
        teamToken,
        nickname: "openclaw",
      }),
      log: rootLogger.child({ channel: "test.hub.search.client" }),
      agent: "openclaw",
      version: "test",
    });
    servers.push({ stop: () => clientRuntime.stop() } as HubServerRuntime);
    await clientRuntime.start();
    const pending = hubDb.repos.hub.listUsers("pending");
    expect(pending).toHaveLength(1);
    await hubRuntime.approveUser(pending[0]!.id);
    expect((await clientRuntime.adminSnapshot()).status).toBe("connected");

    const hits = await clientRuntime.searchMemories("我喜欢看什么书", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.summary).toContain("百年孤独");
    expect(clientDb.repos.traces.list({ limit: 10 })).toHaveLength(0);
  });

  it("hides shared hub memories on unpublish and resurrects them on re-share", async () => {
    const hubDb = makeTmpDb({ agent: "hermes" });
    handles.push(hubDb);

    const port = await freePort();
    const hub = new HubServerRuntime({
      repo: hubDb.repos.hub,
      config: configWithHub({
        enabled: true,
        role: "hub",
        port,
        teamName: "Soft Delete Test",
        teamToken: "soft-delete-token",
      }),
      log: rootLogger.child({ channel: "test.hub.soft-delete" }),
      version: "test",
    });
    servers.push(hub);
    const snapshot = await hub.start();

    const first = hub.publishMemoryAsOwner({
      sourceTraceId: "tr-soft",
      sourceAgent: "hermes",
      kind: "trace",
      summary: "喜欢看的书是《百年孤独》",
      content: "User:\n我喜欢看的书是《百年孤独》",
      embedding: new Float32Array([0.1, 0.9]),
    });
    expect(hub.searchMemories("我喜欢看什么书", 5)).toHaveLength(1);

    hub.unpublishMemoryAsOwner("tr-soft");
    const hidden = hubDb.repos.hub.getSharedMemoryBySource(snapshot.ownerUserId, "tr-soft");
    expect(hidden?.id).toBe(first.id);
    expect(hidden?.visible).toBe(false);
    expect(hidden?.deletedAt).toBeTypeOf("number");
    expect(hub.searchMemories("我喜欢看什么书", 5)).toHaveLength(0);

    const restored = hub.publishMemoryAsOwner({
      sourceTraceId: "tr-soft",
      sourceAgent: "hermes",
      kind: "trace",
      summary: "喜欢看的书是《百年孤独》",
      content: "User:\n我喜欢看的书是《百年孤独》",
      embedding: new Float32Array([0.1, 0.9]),
    });
    const visible = hubDb.repos.hub.getSharedMemoryBySource(snapshot.ownerUserId, "tr-soft");
    expect(restored.id).toBe(first.id);
    expect(visible?.visible).toBe(true);
    expect(visible?.deletedAt).toBeNull();

    hub.publishMemoryAsOwner({
      sourceTraceId: "tr-expired",
      sourceAgent: "hermes",
      kind: "trace",
      summary: "过期共享记忆",
      content: "User:\n过期共享记忆",
    });
    hubDb.repos.hub.hideSharedMemoryBySource(
      snapshot.ownerUserId,
      "tr-expired",
      Date.now() - HUB_SHARED_MEMORY_TOMBSTONE_TTL_MS - 1,
    );
    expect(hubDb.repos.hub.purgeExpiredSharedMemories()).toBe(1);
    expect(hubDb.repos.hub.getSharedMemoryBySource(snapshot.ownerUserId, "tr-expired")).toBeNull();
  });
});

function configWithHub(hub: Partial<ResolvedConfig["hub"]>): ResolvedConfig {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ResolvedConfig;
  return {
    ...base,
    hub: {
      ...base.hub,
      ...hub,
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}
