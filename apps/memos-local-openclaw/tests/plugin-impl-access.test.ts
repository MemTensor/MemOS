import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import plugin from "../plugin-impl";
import { SqliteStore } from "../src/storage/sqlite";
import { issueUserToken } from "../src/hub/auth";

function makeApi(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const tools = new Map<string, any>();
  const events = new Map<string, Function>();
  let service: any;

  const api = {
    pluginConfig,
    config: {},
    resolvePath(input: string) {
      return input === "~/.openclaw" ? stateDir : input;
    },
    logger: {
      info: () => {},
      warn: () => {},
    },
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

describe("plugin-impl hub service skeleton", () => {
  let tmpDir: string;
  let service: any;
  let port: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-plugin-impl-hub-"));
    port = 18901 + Math.floor(Math.random() * 2000);
    ({ service } = makeApi(tmpDir, {
      sharing: {
        enabled: true,
        role: "hub",
        hub: {
          port,
          teamName: "Core Team",
          teamToken: "team-secret",
        },
      },
    }));
  });

  afterEach(async () => {
    await service?.stop?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should start hub service and expose info/join skeleton routes", async () => {
    await service.start();

    const dbPath = path.join(tmpDir, "memos-local", "memos.db");
    const store = new SqliteStore(dbPath, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
    const admins = store.listHubUsers().filter((user) => user.role === "admin" && user.status === "active");
    expect(admins.length).toBeGreaterThanOrEqual(1);
    store.close();

    const info = await fetch(`http://127.0.0.1:${port}/api/v1/hub/info`);
    expect(info.status).toBe(200);
    const infoJson = await info.json();
    expect(infoJson.teamName).toBe("Core Team");
    expect(infoJson.apiVersion).toBe("v1");

    const me = await fetch(`http://127.0.0.1:${port}/api/v1/hub/me`);
    expect(me.status).toBe(401);

    const join = await fetch(`http://127.0.0.1:${port}/api/v1/hub/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "bob",
        deviceName: "Bob Mac",
        teamToken: "team-secret",
      }),
    });
    expect(join.status).toBe(200);
    const joinJson = await join.json();
    expect(joinJson.status).toBe("pending");
    expect(joinJson.userId).toBeTruthy();

    const authState = JSON.parse(fs.readFileSync(path.join(tmpDir, "hub-auth.json"), "utf-8"));
    const adminToken = authState.bootstrapAdminToken;

    const approve = await fetch(`http://127.0.0.1:${port}/api/v1/hub/admin/approve-user`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userId: joinJson.userId, username: "bob" }),
    });
    expect(approve.status).toBe(200);
    const approveJson = await approve.json();
    expect(approveJson.status).toBe("active");
    expect(approveJson.token).toBeTruthy();
  });

  it("should reject forged admin tokens derived from the team token", async () => {
    await service.start();

    const forged = issueUserToken(
      {
        userId: "forged-admin",
        username: "mallory",
        role: "admin",
        status: "active",
      },
      "team-secret",
      60_000,
    );

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub/admin/pending-users`, {
      headers: {
        authorization: `Bearer ${forged}`,
      },
    });

    expect([401, 403]).toContain(res.status);
  });
});

describe("plugin-impl v4 tool registration", () => {
  it("should register the required v4 sharing tools", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-plugin-impl-tools-"));
    const { tools, service } = makeApi(tmpDir, {
      sharing: {
        enabled: true,
        role: "client",
        client: {
          hubAddress: "127.0.0.1:19999",
          userToken: "test-token",
        },
      },
    });

    expect(service).toBeDefined();
    expect(tools.has("task_share")).toBe(true);
    expect(tools.has("task_unshare")).toBe(true);
    expect(tools.has("network_memory_detail")).toBe(true);
    expect(tools.has("network_team_info")).toBe(true);
    expect(tools.has("network_skill_pull")).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("plugin-impl owner isolation", () => {
  let tmpDir: string;
  let tools: Map<string, any>;
  let events: Map<string, Function>;
  let service: any;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedConfigPath: string | undefined;
  let savedStateDir: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-plugin-impl-access-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    savedStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_STATE_DIR;
    ({ tools, events, service } = makeApi(tmpDir));

    const agentEnd = events.get("agent_end")!;

    await agentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "alpha private marker deployment guide" },
          { role: "assistant", content: "alpha private marker response" },
        ],
      },
      { agentId: "alpha", sessionKey: "alpha-session" },
    );

    await agentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "beta private marker rollback guide" },
          { role: "assistant", content: "beta private marker response" },
        ],
      },
      { agentId: "beta", sessionKey: "beta-session" },
    );

    const publicWrite = tools.get("memory_write_public");
    await publicWrite.execute("call-public", { content: "shared public marker convention" }, { agentId: "alpha" });

    const search = tools.get("memory_search");
    await waitFor(async () => {
      const result = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
      return (result?.details?.filtered?.length ?? 0) > 0;
    });
  });

  afterEach(() => {
    service?.stop?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = savedConfigPath;
    if (savedStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = savedStateDir;
  });

  it("memory_search should scope results by agentId", async () => {
    const search = tools.get("memory_search");

    const alpha = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
    const beta = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "beta" });
    const publicHit = await search.execute("call-search", { query: "shared public marker", maxResults: 5, minScore: 0.1 }, { agentId: "beta" });

    expect(alpha.details.filtered.length).toBeGreaterThan(0);
    const betaAlphaHits = (beta.details?.filtered ?? []).filter((h: any) =>
      h.original_excerpt?.includes("alpha") || h.summary?.includes("alpha"),
    );
    expect(betaAlphaHits).toHaveLength(0);
    expect(publicHit.details.filtered.length).toBeGreaterThan(0);
  });

  it("memory_timeline should not leak another agent's private neighbors", async () => {
    const search = tools.get("memory_search");
    const timeline = tools.get("memory_timeline");

    const alpha = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
    const chunkId = alpha.details.filtered[0].chunkId;
    const betaTimeline = await timeline.execute("call-timeline", { chunkId }, { agentId: "beta" });

    expect(betaTimeline.details.entries).toEqual([]);
  });

  it("memory_timeline should keep visible neighbors inside the requested window", async () => {
    const store = new SqliteStore(path.join(tmpDir, "memos-local", "memos.db"), { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
    const now = Date.now();

    store.insertChunk({
      id: "timeline-visible-before",
      sessionKey: "mixed-session",
      turnId: "mixed-turn-1",
      seq: 0,
      role: "assistant",
      owner: "agent:alpha",
      content: "visible before alpha chunk",
      summary: "visible before alpha chunk",
      kind: "paragraph",
      createdAt: now,
      updatedAt: now,
      dedupStatus: "active",
      dedupTargetId: null,
      dedupReason: null,
      taskId: null,
      skillId: null,
      contentHash: null,
    });
    store.insertChunk({
      id: "timeline-hidden-1",
      sessionKey: "mixed-session",
      turnId: "mixed-turn-1",
      seq: 1,
      role: "assistant",
      owner: "agent:beta",
      content: "hidden beta chunk 1",
      summary: "hidden beta chunk 1",
      kind: "paragraph",
      createdAt: now + 1,
      updatedAt: now + 1,
      dedupStatus: "active",
      dedupTargetId: null,
      dedupReason: null,
      taskId: null,
      skillId: null,
      contentHash: null,
    });
    store.insertChunk({
      id: "timeline-hidden-2",
      sessionKey: "mixed-session",
      turnId: "mixed-turn-1",
      seq: 2,
      role: "assistant",
      owner: "agent:beta",
      content: "hidden beta chunk 2",
      summary: "hidden beta chunk 2",
      kind: "paragraph",
      createdAt: now + 2,
      updatedAt: now + 2,
      dedupStatus: "active",
      dedupTargetId: null,
      dedupReason: null,
      taskId: null,
      skillId: null,
      contentHash: null,
    });
    store.insertChunk({
      id: "timeline-anchor",
      sessionKey: "mixed-session",
      turnId: "mixed-turn-2",
      seq: 0,
      role: "assistant",
      owner: "agent:alpha",
      content: "anchor alpha chunk",
      summary: "anchor alpha chunk",
      kind: "paragraph",
      createdAt: now + 3,
      updatedAt: now + 3,
      dedupStatus: "active",
      dedupTargetId: null,
      dedupReason: null,
      taskId: null,
      skillId: null,
      contentHash: null,
    });
    store.insertChunk({
      id: "timeline-hidden-3",
      sessionKey: "mixed-session",
      turnId: "mixed-turn-2",
      seq: 1,
      role: "assistant",
      owner: "agent:beta",
      content: "hidden beta chunk 3",
      summary: "hidden beta chunk 3",
      kind: "paragraph",
      createdAt: now + 4,
      updatedAt: now + 4,
      dedupStatus: "active",
      dedupTargetId: null,
      dedupReason: null,
      taskId: null,
      skillId: null,
      contentHash: null,
    });
    store.insertChunk({
      id: "timeline-hidden-4",
      sessionKey: "mixed-session",
      turnId: "mixed-turn-2",
      seq: 2,
      role: "assistant",
      owner: "agent:beta",
      content: "hidden beta chunk 4",
      summary: "hidden beta chunk 4",
      kind: "paragraph",
      createdAt: now + 5,
      updatedAt: now + 5,
      dedupStatus: "active",
      dedupTargetId: null,
      dedupReason: null,
      taskId: null,
      skillId: null,
      contentHash: null,
    });
    store.insertChunk({
      id: "timeline-visible-after",
      sessionKey: "mixed-session",
      turnId: "mixed-turn-3",
      seq: 0,
      role: "assistant",
      owner: "agent:alpha",
      content: "visible after alpha chunk",
      summary: "visible after alpha chunk",
      kind: "paragraph",
      createdAt: now + 6,
      updatedAt: now + 6,
      dedupStatus: "active",
      dedupTargetId: null,
      dedupReason: null,
      taskId: null,
      skillId: null,
      contentHash: null,
    });
    store.close();

    const timeline = tools.get("memory_timeline");
    const alphaTimeline = await timeline.execute("call-timeline", { chunkId: "timeline-anchor", window: 1 }, { agentId: "alpha" });

    expect(alphaTimeline.details.entries.map((entry: any) => entry.excerpt)).toEqual([
      "visible before alpha chunk",
      "anchor alpha chunk",
      "visible after alpha chunk",
    ]);
  });

  it("memory_get should not return another agent's private chunk", async () => {
    const search = tools.get("memory_search");
    const getTool = tools.get("memory_get");

    const alpha = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
    const chunkId = alpha.details.filtered[0].chunkId;
    const betaGet = await getTool.execute("call-get", { chunkId }, { agentId: "beta" });

    expect(betaGet.details.error).toBe("not_found");
  });
});
