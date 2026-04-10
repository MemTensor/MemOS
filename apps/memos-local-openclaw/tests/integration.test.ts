import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import memosLocalPlugin from "../index";
import { initPlugin, type MemosLocalPlugin } from "../src/index";
import { buildContext, resolveConfig } from "../src/config";
import { Embedder } from "../src/embedding";
import { HubServer } from "../src/hub/server";
import { Summarizer } from "../src/ingest/providers";
import { SqliteStore } from "../src/storage/sqlite";
import { ViewerServer } from "../src/viewer/server";

const testLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const noopLog = testLog;

function makePluginApi(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const tools = new Map<string, any>();
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
    on() {},
  } as any;

  memosLocalPlugin.register(api);
  return { tools, service };
}

function makeTaskChunk(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "chunk-local-1",
    sessionKey: "session-local-share",
    turnId: "turn-local-share",
    seq: 0,
    role: "user",
    content: "Share the Docker rollout checklist with the hub.",
    kind: "paragraph",
    summary: "Docker rollout checklist",
    embedding: null,
    taskId: "task-local-1",
    skillId: null,
    owner: "agent:main",
    dedupStatus: "active",
    dedupTarget: null,
    dedupReason: null,
    mergeCount: 0,
    lastHitAt: null,
    mergeHistory: "[]",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function setupFederatedMemorySearchHarness() {
  const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-federated-client-"));
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-federated-hub-"));
  const port = 19200 + Math.floor(Math.random() * 1000);
  const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog as any);
  const hubServer = new HubServer({
    store: hubStore,
    log: noopLog as any,
    config: {
      sharing: {
        enabled: true,
        role: "hub",
        hub: {
          port,
          teamName: "Federated Search Test",
          teamToken: "federated-search-secret",
        },
      },
    } as any,
    dataDir: hubDir,
  } as any);

  await hubServer.start();
  const authState = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
  const userToken = authState.bootstrapAdminToken as string;
  const userId = authState.bootstrapAdminUserId as string;

  hubStore.upsertHubGroup({
    id: "group-rollout",
    name: "Rollout",
    description: "Rollout group",
    createdAt: 1,
  });
  hubStore.addHubGroupMember("group-rollout", userId, 1);

  hubStore.upsertHubTask({
    id: "hub-task-group-rollout",
    sourceTaskId: "group-rollout-task",
    sourceUserId: userId,
    title: "Group rollout checklist",
    summary: "Group-only rollout checklist for the release train",
    groupId: "group-rollout",
    visibility: "group",
    createdAt: 1,
    updatedAt: 1,
  });
  hubStore.upsertHubChunk({
    id: "hub-chunk-group-rollout",
    hubTaskId: "hub-task-group-rollout",
    sourceTaskId: "group-rollout-task",
    sourceChunkId: "group-rollout-chunk",
    sourceUserId: userId,
    role: "assistant",
    content: "Shared rollout checklist for the group hub: verify canary deploy, smoke tests, and rollback owner.",
    summary: "Shared rollout checklist for the group hub",
    kind: "paragraph",
    createdAt: 2,
  });

  hubStore.upsertHubTask({
    id: "hub-task-public-rollout",
    sourceTaskId: "public-rollout-task",
    sourceUserId: userId,
    title: "Public rollout checklist",
    summary: "Public rollout checklist for all clients",
    groupId: null,
    visibility: "public",
    createdAt: 3,
    updatedAt: 3,
  });
  hubStore.upsertHubChunk({
    id: "hub-chunk-public-rollout",
    hubTaskId: "hub-task-public-rollout",
    sourceTaskId: "public-rollout-task",
    sourceChunkId: "public-rollout-chunk",
    sourceUserId: userId,
    role: "assistant",
    content: "Public shared rollout checklist: announce deploy window and verify dashboards after release.",
    summary: "Public shared rollout checklist",
    kind: "paragraph",
    createdAt: 4,
  });

  const clientPlugin = initPlugin({
    stateDir: clientDir,
    config: {
      sharing: {
        enabled: true,
        role: "client",
        client: {
          hubAddress: `127.0.0.1:${port}`,
          userToken,
        },
      },
      telemetry: { enabled: false },
    },
  });

  clientPlugin.onConversationTurn([
    {
      role: "user",
      content: "Keep a local shared rollout checklist for the client deploy: verify migrations, confirm local smoke tests, and post status.",
    },
    {
      role: "assistant",
      content: "Local shared rollout checklist captured with client-only smoke test details.",
    },
  ], "session-federated-rollout");

  await clientPlugin.flush();

  return {
    clientDir,
    hubDir,
    hubStore,
    hubServer,
    clientPlugin,
  };
}

async function teardownFederatedMemorySearchHarness(harness: Awaited<ReturnType<typeof setupFederatedMemorySearchHarness>>) {
  await harness.clientPlugin.shutdown();
  await harness.hubServer.stop();
  harness.hubStore.close();
  fs.rmSync(harness.clientDir, { recursive: true, force: true });
  fs.rmSync(harness.hubDir, { recursive: true, force: true });
}

let plugin: MemosLocalPlugin;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-integration-"));
  plugin = initPlugin({
    stateDir: tmpDir,
    config: {
      // No summarizer → rule-based fallback
      // No embedding → local MiniLM fallback
    },
  });

  // Simulate a conversation: user talks about deploying a service
  plugin.onConversationTurn([
    { role: "user", content: "I'm deploying our API service to port 8443 using Docker. The command is: `docker compose -f docker-compose.prod.yml up -d`. The Postgres password is configured via POSTGRES_PASSWORD env var." },
    { role: "assistant", content: "Got it. I'll help you deploy. Make sure the firewall allows port 8443 and that POSTGRES_PASSWORD is set in your .env file. The docker-compose.prod.yml should have health checks configured." },
  ], "session-deploy");

  // Second turn about a different topic
  plugin.onConversationTurn([
    { role: "user", content: "Now let's discuss the React frontend. We're using Next.js 14 with App Router. The main page component is at app/page.tsx and it fetches data from /api/dashboard." },
    { role: "assistant", content: "For the Next.js 14 App Router setup, your app/page.tsx should use server components by default. The /api/dashboard route handler should be in app/api/dashboard/route.ts." },
  ], "session-frontend");

  // Third turn with an error stack
  plugin.onConversationTurn([
    { role: "user", content: `The build is failing with this error:
Error: Module not found: Can't resolve '@/components/Chart'
    at ModuleNotFoundError (webpack/lib/ModuleNotFoundError.js:28:12)
    at factorize (webpack/lib/Compilation.js:2045:24)
    at resolve (webpack/lib/NormalModuleFactory.js:439:20)

I think the path alias is wrong in the tsconfig configuration.` },
    { role: "assistant", content: "The error shows a missing path alias for @/components/Chart. Check your tsconfig.json paths configuration - it should have: \"@/*\": [\"./src/*\"] or similar mapping." },
  ], "session-frontend");

  plugin.onConversationTurn([
    { role: "user", content: "alpha private marker only alpha should see this rollout note" },
    { role: "assistant", content: "Recorded alpha private marker deployment note." },
  ], "session-alpha-private", "agent:alpha");

  plugin.onConversationTurn([
    { role: "user", content: "beta private marker only beta should see this rollback note" },
    { role: "assistant", content: "Recorded beta private marker rollback note." },
  ], "session-beta-private", "agent:beta");

  plugin.onConversationTurn([
    { role: "user", content: "shared public marker all agents can use this shared convention" },
    { role: "assistant", content: "Recorded shared public marker convention." },
  ], "session-public", "public");

  // Wait for all async ingest to complete
  await plugin.flush();
}, 120_000);

afterAll(() => {
  plugin.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Integration: v4 types and config foundation", () => {
  it("should keep local-only config backward compatible while adding sharing defaults", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-config-"));

    const resolved = resolveConfig(undefined, stateDir) as any;

    expect(resolved.storage.dbPath).toContain("memos-local");
    expect(resolved.recall.maxResultsDefault).toBe(6);
    expect(resolved.sharing).toBeDefined();
    expect(resolved.sharing.enabled).toBe(false);
    expect(resolved.sharing.role).toBe("client");
    expect(resolved.sharing.hub.port).toBe(18800);
    expect(resolved.sharing.client.hubAddress).toBe("");
    expect(resolved.sharing.capabilities.hostEmbedding).toBe(false);
    expect(resolved.sharing.capabilities.hostCompletion).toBe(false);

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("should resolve sharing env vars and expose hub/client config via buildContext", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-context-"));
    const prevTeamToken = process.env.MEMOS_TEAM_TOKEN;
    const prevUserToken = process.env.MEMOS_USER_TOKEN;

    process.env.MEMOS_TEAM_TOKEN = "team-secret";
    process.env.MEMOS_USER_TOKEN = "user-secret";

    try {
      const ctx = buildContext(
        stateDir,
        process.cwd(),
        {
          summarizer: {
            provider: "openclaw",
          },
          embedding: {
            provider: "openclaw",
          },
          sharing: {
            enabled: true,
            role: "hub",
            hub: {
              port: 19001,
              teamName: "Core Team",
              teamToken: "${MEMOS_TEAM_TOKEN}",
            },
            client: {
              hubAddress: "10.0.0.8:18800",
              userToken: "${MEMOS_USER_TOKEN}",
            },
            capabilities: {
              hostEmbedding: true,
              hostCompletion: true,
            },
          },
        } as any,
      ) as any;

      expect(ctx.config.sharing.enabled).toBe(true);
      expect(ctx.config.sharing.role).toBe("hub");
      expect(ctx.config.sharing.hub.teamToken).toBe("team-secret");
      // When role=hub, resolveConfig clears client fields (hub and client are mutually exclusive)
      expect(ctx.config.sharing.client.userToken).toBe("");
      expect(ctx.config.sharing.capabilities.hostEmbedding).toBe(true);
      expect(ctx.config.sharing.capabilities.hostCompletion).toBe(true);
      expect(ctx.config.embedding?.capabilities?.hostEmbedding).toBe(true);
      expect(ctx.config.summarizer?.capabilities?.hostCompletion).toBe(true);
    } finally {
      if (prevTeamToken === undefined) delete process.env.MEMOS_TEAM_TOKEN;
      else process.env.MEMOS_TEAM_TOKEN = prevTeamToken;

      if (prevUserToken === undefined) delete process.env.MEMOS_USER_TOKEN;
      else process.env.MEMOS_USER_TOKEN = prevUserToken;

      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("should fall back safely when openclaw provider is configured without host capability flags", async () => {
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "memos-fallback-home-"));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_STATE_DIR;

    try {
      const embedder = new Embedder({ provider: "openclaw" } as any, testLog as any);
      const summarizer = new Summarizer({ provider: "openclaw" } as any, testLog as any);
      const input = "OpenClaw fallback summary line stays local and safe.";

      expect(embedder.provider).toBe("local");
      expect(embedder.dimensions).toBe(384);
      await expect(summarizer.summarize(input)).resolves.toBe(input);
      await expect(summarizer.summarizeTask(input)).resolves.toBe(input);
      await expect(summarizer.judgeNewTopic("current topic", "new message")).resolves.toBeNull();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
      else process.env.OPENCLAW_CONFIG_PATH = prevConfigPath;
      if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevStateDir;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("should apply the same capability-aware resolution in viewer config consumers", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-home-"));
    const stateDir = path.join(homeDir, ".openclaw");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-data-"));
    const cfgPath = path.join(stateDir, "openclaw.json");
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({
      plugins: {
        entries: {
          "memos-local-openclaw-plugin": {
            enabled: true,
            config: {
              embedding: { provider: "openclaw" },
              summarizer: { provider: "openclaw" },
              sharing: {
                capabilities: {
                  hostEmbedding: false,
                  hostCompletion: false,
                },
              },
            },
          },
        },
      },
    }), "utf-8");

    process.env.HOME = homeDir;
    if (prevUserProfile !== undefined) delete process.env.USERPROFILE;

    try {
      const viewer = new ViewerServer({
        store: {} as any,
        embedder: { provider: "local" } as any,
        port: 0,
        log: testLog as any,
        dataDir,
        ctx: buildContext(stateDir, process.cwd(), undefined, testLog as any),
      });

      const unavailable = (viewer as any).getResolvedViewerConfig(JSON.parse(fs.readFileSync(cfgPath, "utf-8")));
      expect((viewer as any).hasUsableEmbeddingProvider(unavailable)).toBe(false);
      expect((viewer as any).hasUsableSummarizerProvider(unavailable)).toBe(false);

      const available = resolveConfig({
        embedding: { provider: "openclaw" },
        summarizer: { provider: "openclaw" },
        sharing: {
          capabilities: {
            hostEmbedding: true,
            hostCompletion: true,
          },
        },
      } as any, stateDir);

      expect((viewer as any).hasUsableEmbeddingProvider(available)).toBe(false);
      expect((viewer as any).hasUsableSummarizerProvider(available)).toBe(false);
      expect(available.summarizer?.capabilities?.hostCompletion).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;

      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;

      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("Integration: memory_search hub scope", () => {
  it("should return split local and hub results for scope=group", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-search-hub-"));
    const port = 19200 + Math.floor(Math.random() * 500);
    const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog as any);
    const hubServer = new HubServer({
      store: hubStore,
      log: noopLog as any,
      config: { sharing: { enabled: true, role: "hub", hub: { port, teamName: "Search Hub", teamToken: "search-hub-secret" } } },
      dataDir: hubDir,
    } as any);

    await hubServer.start();
    const authState = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
    const userId = authState.bootstrapAdminUserId as string;
    const userToken = authState.bootstrapAdminToken as string;

    const shareRes = await fetch(`http://127.0.0.1:${port}/api/v1/hub/tasks/share`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${userToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        task: {
          id: "hub-task-search-1",
          sourceTaskId: "task-hub-1",
          sourceUserId: userId,
          title: "Shared Nginx Notes",
          summary: "nginx notes",
          groupId: null,
          visibility: "public",
          createdAt: 1,
          updatedAt: 1,
        },
        chunks: [
          {
            id: "hub-chunk-search-1",
            hubTaskId: "hub-task-search-1",
            sourceTaskId: "task-hub-1",
            sourceChunkId: "chunk-hub-1",
            sourceUserId: userId,
            role: "assistant",
            content: "Shared nginx upstream config with proxy_pass to 3000.",
            summary: "shared nginx upstream config",
            kind: "paragraph",
            createdAt: 2,
          },
        ],
      }),
    });
    expect(shareRes.status).toBe(200);

    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({
      query: "nginx upstream config",
      scope: "group",
      hubAddress: `127.0.0.1:${port}`,
      userToken,
    })) as any;

    expect(result.local).toBeDefined();
    expect(result.hub).toBeDefined();
    expect(Array.isArray(result.hub.hits)).toBe(true);
    expect(result.hub.hits.length).toBeGreaterThan(0);
    expect(result.hub.hits[0].taskTitle).toBe("Shared Nginx Notes");

    await hubServer.stop();
    hubStore.close();
    fs.rmSync(hubDir, { recursive: true, force: true });
  });
});

describe("Integration: memory_search", () => {
  it("should find docker deployment details", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "docker deploy port 8443" })) as any;

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.meta.usedMinScore).toBe(0.45);
    expect(result.meta.usedMaxResults).toBe(6);

    const hit = result.hits[0];
    expect(hit.summary).toBeTruthy();
    expect(hit.original_excerpt).toBeTruthy();
    expect(hit.ref).toBeDefined();
    expect(hit.ref.sessionKey).toBeTruthy();
    expect(hit.ref.chunkId).toBeTruthy();
    expect(hit.score).toBeGreaterThanOrEqual(0);
    expect(hit.score).toBeLessThanOrEqual(1);
    expect(hit.source.ts).toBeGreaterThan(0);
  });

  it("should find Next.js frontend details", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "Next.js App Router page.tsx" })) as any;

    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("should find error stack information", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "Module not found Chart component" })) as any;

    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("should respect maxResults parameter", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "deploy", maxResults: 2 })) as any;

    expect(result.hits.length).toBeLessThanOrEqual(2);
    expect(result.meta.usedMaxResults).toBe(2);
  });

  it("should produce note on repeated identical query", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

    await searchTool.handler({ query: "unique test query xyz", maxResults: 6, minScore: 0.45 });
    const result2 = (await searchTool.handler({ query: "unique test query xyz", maxResults: 6, minScore: 0.45 })) as any;

    expect(result2.meta.note).toBeDefined();
    expect(result2.meta.note).toContain("already");
  });

  it("should return local and hub sections for scope=group", async () => {
    const harness = await setupFederatedMemorySearchHarness();

    try {
      const searchTool = harness.clientPlugin.tools.find((t) => t.name === "memory_search")!;
      const result = (await searchTool.handler({ query: "rollout checklist", scope: "group" })) as any;

      expect(result.local.hits.length).toBeGreaterThan(0);
      expect(result.local.meta.usedMaxResults).toBe(6);
      expect(result.hub.hits.length).toBeGreaterThan(0);
      expect(result.hub.hits.some((hit: any) => hit.visibility === "group")).toBe(true);
      expect(result.hub.hits[0].remoteHitId).toBeTruthy();
      expect(result.hub.meta.totalCandidates).toBeGreaterThan(0);
    } finally {
      await teardownFederatedMemorySearchHarness(harness);
    }
  });

  it("should return local and hub sections for scope=all", async () => {
    const harness = await setupFederatedMemorySearchHarness();

    try {
      const searchTool = harness.clientPlugin.tools.find((t) => t.name === "memory_search")!;
      const result = (await searchTool.handler({ query: "shared rollout checklist", scope: "all", maxResults: 5 })) as any;

      expect(result.local.hits.length).toBeGreaterThan(0);
      expect(result.local.meta.usedMaxResults).toBe(5);
      expect(result.hub.hits.length).toBeGreaterThan(0);
      expect(result.hub.hits.some((hit: any) => hit.visibility === "public")).toBe(true);
      expect(result.hub.meta.totalCandidates).toBeGreaterThan(0);
    } finally {
      await teardownFederatedMemorySearchHarness(harness);
    }
  });

  it("should return memory detail for a hub search hit", async () => {
    const harness = await setupFederatedMemorySearchHarness();

    try {
      const searchTool = harness.clientPlugin.tools.find((t) => t.name === "memory_search")!;
      const detailTool = harness.clientPlugin.tools.find((t) => t.name === "network_memory_detail")!;
      const result = (await searchTool.handler({ query: "shared rollout checklist", scope: "all", maxResults: 5 })) as any;
      const targetHit = result.hub.hits.find((hit: any) => hit.visibility === "public") ?? result.hub.hits[0];

      const detail = (await detailTool.handler({ remoteHitId: targetHit.remoteHitId })) as any;

      expect(detail.summary).toContain("rollout checklist");
      expect(detail.content).toContain("announce deploy window");
      expect(detail.source.role).toBe("assistant");
    } finally {
      await teardownFederatedMemorySearchHarness(harness);
    }
  });
});

describe("Integration: memory_timeline", () => {
  it("should return neighboring context around a hit", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const timelineTool = plugin.tools.find((t) => t.name === "memory_timeline")!;

    const searchResult = (await searchTool.handler({ query: "docker compose" })) as any;
    if (searchResult.hits.length === 0) return; // skip if no hits

    const ref = searchResult.hits[0].ref;
    const timelineResult = (await timelineTool.handler({ ref, window: 2 })) as any;

    expect(timelineResult.entries).toBeDefined();
    expect(timelineResult.entries.length).toBeGreaterThan(0);
    expect(timelineResult.anchorRef).toEqual(ref);

    const entry = timelineResult.entries[0];
    expect(entry.excerpt).toBeTruthy();
    expect(entry.ref).toBeDefined();
    expect(["before", "current", "after"]).toContain(entry.relation);
  });
});

describe("Integration: memory_get", () => {
  it("should return full original text of a chunk", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const getTool = plugin.tools.find((t) => t.name === "memory_get")!;

    const searchResult = (await searchTool.handler({ query: "docker compose" })) as any;
    if (searchResult.hits.length === 0) return;

    const ref = searchResult.hits[0].ref;
    const getResult = (await getTool.handler({ ref })) as any;

    expect(getResult.content).toBeTruthy();
    expect(getResult.ref).toBeDefined();
    expect(getResult.source).toBeDefined();
    expect(getResult.source.ts).toBeGreaterThan(0);
  });

  it("should respect maxChars parameter", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const getTool = plugin.tools.find((t) => t.name === "memory_get")!;

    const searchResult = (await searchTool.handler({ query: "docker" })) as any;
    if (searchResult.hits.length === 0) return;

    const ref = searchResult.hits[0].ref;
    const getResult = (await getTool.handler({ ref, maxChars: 50 })) as any;

    expect(getResult.content.length).toBeLessThanOrEqual(52); // 50 + "…"
  });
});

describe("Integration: owner isolation for initPlugin tools", () => {
  it("memory_search should respect owner on initPlugin path", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

    const betaSearch = (await searchTool.handler({
      query: "alpha private marker",
      owner: "agent:beta",
    })) as any;

    // beta should not see alpha's private memories
    const betaAlphaHits = (betaSearch.hits ?? []).filter((h: any) => h.ref?.sessionKey === "session-alpha-private");
    expect(betaAlphaHits).toHaveLength(0);

    const publicSearch = (await searchTool.handler({
      query: "shared public marker",
      owner: "agent:beta",
    })) as any;

    expect(publicSearch.hits.length).toBeGreaterThan(0);
    expect(publicSearch.hits.some((hit: any) => hit.ref.sessionKey === "session-public")).toBe(true);
  });

  it("memory_timeline should not expose another owner's chunks on initPlugin path", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const timelineTool = plugin.tools.find((t) => t.name === "memory_timeline")!;

    const alphaSearch = (await searchTool.handler({
      query: "alpha private marker",
      owner: "agent:alpha",
    })) as any;

    expect(alphaSearch.hits.length).toBeGreaterThan(0);

    const ref = alphaSearch.hits[0].ref;
    const leaked = (await timelineTool.handler({ ref, owner: "agent:beta", window: 2 })) as any;

    expect(leaked.entries).toEqual([]);
  });

  it("memory_get should not expose another owner's chunk on initPlugin path", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const getTool = plugin.tools.find((t) => t.name === "memory_get")!;

    const alphaSearch = (await searchTool.handler({
      query: "alpha private marker",
      owner: "agent:alpha",
    })) as any;

    expect(alphaSearch.hits.length).toBeGreaterThan(0);

    const ref = alphaSearch.hits[0].ref;
    const leaked = (await getTool.handler({ ref, owner: "agent:beta" })) as any;

    expect(leaked.error).toContain(ref.chunkId);
  });
});

describe("Integration: root plugin memory_search network scope", () => {
  async function setupRootMemorySearchHarness() {
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-root-search-client-"));
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-root-search-hub-"));
    const port = 19600 + Math.floor(Math.random() * 1000);
    const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog as any);
    const hubServer = new HubServer({
      store: hubStore,
      log: noopLog as any,
      config: {
        sharing: {
          enabled: true,
          role: "hub",
          hub: {
            port,
            teamName: "Root Search Test",
            teamToken: "root-search-secret",
          },
        },
      } as any,
      dataDir: hubDir,
    } as any);

    await hubServer.start();
    const authState = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
    const userToken = authState.bootstrapAdminToken as string;
    const userId = authState.bootstrapAdminUserId as string;

    hubStore.upsertHubTask({
      id: "hub-task-root-search-1",
      sourceTaskId: "task-root-search-1",
      sourceUserId: userId,
      title: "Hub rollout",
      summary: "Hub rollout checklist",
      groupId: null,
      visibility: "public",
      createdAt: 1,
      updatedAt: 1,
    });
    hubStore.upsertHubChunk({
      id: "hub-chunk-root-search-1",
      hubTaskId: "hub-task-root-search-1",
      sourceTaskId: "task-root-search-1",
      sourceChunkId: "chunk-root-search-1",
      sourceUserId: userId,
      role: "assistant",
      content: "Public rollout checklist from hub with nginx canary validation.",
      summary: "Hub rollout checklist",
      kind: "paragraph",
      createdAt: 2,
    });

    const { tools, service } = makePluginApi(clientDir, {
      sharing: {
        enabled: true,
        role: "client",
        client: {
          hubAddress: `127.0.0.1:${port}`,
          userToken,
        },
      },
      telemetry: { enabled: false },
    });

    const clientStore = new SqliteStore(path.join(clientDir, "memos-local", "memos.db"), noopLog as any);
    clientStore.insertTask({
      id: "task-root-local-1",
      sessionKey: "session-root-local",
      title: "Local rollout",
      summary: "Local rollout checklist",
      status: "completed",
      owner: "agent:main",
      startedAt: 1,
      endedAt: 2,
      updatedAt: 2,
    });
    clientStore.insertChunk(makeTaskChunk({
      id: "chunk-root-local-1",
      sessionKey: "session-root-local",
      turnId: "turn-root-local",
      content: "Local rollout checklist with smoke tests and deploy validation.",
      summary: "Local rollout checklist",
      taskId: "task-root-local-1",
    }));

    return { clientDir, hubDir, tools, service, clientStore, hubStore, hubServer };
  }

  async function teardownRootMemorySearchHarness(harness: Awaited<ReturnType<typeof setupRootMemorySearchHarness>>) {
    await harness.service?.stop?.();
    harness.clientStore.close();
    await harness.hubServer.stop();
    harness.hubStore.close();
    fs.rmSync(harness.clientDir, { recursive: true, force: true });
    fs.rmSync(harness.hubDir, { recursive: true, force: true });
  }

  it("root memory_search should return split local and hub results for scope=all", async () => {
    const harness = await setupRootMemorySearchHarness();
    try {
      const searchTool = harness.tools.get("memory_search");
      expect(searchTool).toBeDefined();

      const result = await searchTool.execute("call-root-search", { query: "rollout checklist", scope: "all", maxResults: 5 }, { agentId: "main" });
      expect((result.details.filtered ?? []).some((hit: any) => hit.origin !== "hub-remote")).toBe(true);
      expect((result.details.filtered ?? []).some((hit: any) => hit.origin === "hub-remote")).toBe(true);
      expect((result.details.hubCandidates ?? []).length).toBeGreaterThan(0);
    } finally {
      await teardownRootMemorySearchHarness(harness);
    }
  });
});

describe("Integration: task sharing MVP", () => {
  async function setupTaskSharingHarness(opts: {
    usePersistedConnection?: boolean;
    fallbackHubAddress?: string;
    fallbackUserToken?: string;
  } = {}) {
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-share-client-"));
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-share-hub-"));
    const port = 19100 + Math.floor(Math.random() * 1000);
    const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog as any);
    const hubServer = new HubServer({
      store: hubStore,
      log: noopLog as any,
      config: {
        sharing: {
          enabled: true,
          role: "hub",
          hub: {
            port,
            teamName: "Task Share Test",
            teamToken: "task-share-secret",
          },
        },
      } as any,
      dataDir: hubDir,
    } as any);

    await hubServer.start();
    const authState = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
    const userToken = authState.bootstrapAdminToken as string;
    const userId = authState.bootstrapAdminUserId as string;

    const { tools, service } = makePluginApi(clientDir, {
      sharing: {
        enabled: true,
        role: "client",
        client: {
          hubAddress: opts.fallbackHubAddress ?? `127.0.0.1:${port}`,
          userToken: opts.fallbackUserToken ?? userToken,
        },
      },
      telemetry: { enabled: false },
    });

    const clientStore = new SqliteStore(path.join(clientDir, "memos-local", "memos.db"), noopLog as any);
    clientStore.insertTask({
      id: "task-local-1",
      sessionKey: "session-local-share",
      title: "Docker rollout checklist",
      summary: "Steps to share the Docker rollout checklist with the team hub",
      status: "completed",
      owner: "agent:main",
      startedAt: 100,
      endedAt: 200,
      updatedAt: 200,
    });
    clientStore.insertChunk(makeTaskChunk());
    clientStore.insertChunk(makeTaskChunk({
      id: "chunk-local-2",
      seq: 1,
      role: "assistant",
      content: "Verify port 8443 and POSTGRES_PASSWORD before deploy.",
      summary: "Verify port 8443 and POSTGRES_PASSWORD",
    }));

    if (opts.usePersistedConnection) {
      clientStore.setClientHubConnection({
        hubUrl: `http://127.0.0.1:${port}`,
        userId,
        username: "admin",
        userToken,
        role: "admin",
        connectedAt: Date.now(),
      });
    }

    return {
      clientDir,
      hubDir,
      port,
      userId,
      userToken,
      tools,
      service,
      clientStore,
      hubStore,
      hubServer,
    };
  }

  async function teardownTaskSharingHarness(harness: Awaited<ReturnType<typeof setupTaskSharingHarness>>) {
    await harness.service?.stop?.();
    harness.clientStore.close();
    await harness.hubServer.stop();
    harness.hubStore.close();
    fs.rmSync(harness.clientDir, { recursive: true, force: true });
    fs.rmSync(harness.hubDir, { recursive: true, force: true });
  }

  it("task_share and task_unshare should push and remove a local task via config fallback", async () => {
    const harness = await setupTaskSharingHarness();

    try {
      const shareTool = harness.tools.get("task_share");
      const unshareTool = harness.tools.get("task_unshare");
      expect(shareTool).toBeDefined();
      expect(unshareTool).toBeDefined();

      const shareResult = await shareTool.execute("call-share", { taskId: "task-local-1", visibility: "public" }, { agentId: "main" });
      expect(shareResult.details.shared).toBe(true);
      expect(shareResult.details.chunkCount).toBe(2);

      const sharedTask = harness.hubStore.getHubTaskBySource(harness.userId, "task-local-1");
      expect(sharedTask).not.toBeNull();
      expect(sharedTask!.title).toBe("Docker rollout checklist");

      const sharedChunk = harness.hubStore.getHubChunkBySource(harness.userId, "chunk-local-1");
      expect(sharedChunk).not.toBeNull();
      expect(sharedChunk!.summary).toBe("Docker rollout checklist");

      const unshareResult = await unshareTool.execute("call-unshare", { taskId: "task-local-1" }, { agentId: "main" });
      expect(unshareResult.details.unshared).toBe(true);
      expect(harness.hubStore.getHubTaskBySource(harness.userId, "task-local-1")).toBeNull();
      expect(harness.hubStore.getHubChunkBySource(harness.userId, "chunk-local-1")).toBeNull();
    } finally {
      await teardownTaskSharingHarness(harness);
    }
  });

  it("task_share should prefer persisted hub connection over fallback config", async () => {
    const harness = await setupTaskSharingHarness({
      usePersistedConnection: true,
      fallbackHubAddress: "127.0.0.1:9",
      fallbackUserToken: "bad-token",
    });

    try {
      const shareTool = harness.tools.get("task_share");
      const shareResult = await shareTool.execute("call-share", { taskId: "task-local-1", visibility: "public" }, { agentId: "main" });

      expect(shareResult.details.shared).toBe(true);
      expect(harness.hubStore.getHubTaskBySource(harness.userId, "task-local-1")).not.toBeNull();
    } finally {
      await teardownTaskSharingHarness(harness);
    }
  });
});

describe("Integration: network memory detail tool", () => {
  async function setupNetworkMemoryDetailHarness() {
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-network-detail-client-"));
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-network-detail-hub-"));
    const port = 19300 + Math.floor(Math.random() * 1000);
    const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog as any);
    const hubServer = new HubServer({
      store: hubStore,
      log: noopLog as any,
      config: {
        sharing: {
          enabled: true,
          role: "hub",
          hub: {
            port,
            teamName: "Memory Detail Test",
            teamToken: "memory-detail-secret",
          },
        },
      } as any,
      dataDir: hubDir,
    } as any);

    await hubServer.start();
    const authState = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
    const userToken = authState.bootstrapAdminToken as string;
    const userId = authState.bootstrapAdminUserId as string;

    hubStore.upsertHubTask({
      id: "hub-task-detail-1",
      sourceTaskId: "task-detail-1",
      sourceUserId: userId,
      title: "Deploy Nginx",
      summary: "deploy nginx summary",
      groupId: null,
      visibility: "public",
      createdAt: 1,
      updatedAt: 1,
    });
    hubStore.upsertHubChunk({
      id: "hub-chunk-detail-1",
      hubTaskId: "hub-task-detail-1",
      sourceTaskId: "task-detail-1",
      sourceChunkId: "chunk-detail-1",
      sourceUserId: userId,
      role: "assistant",
      content: "Use nginx upstream and proxy_pass to port 3000.",
      summary: "nginx upstream to port 3000",
      kind: "paragraph",
      createdAt: 2,
    });

    const searchRes = await fetch(`http://127.0.0.1:${port}/api/v1/hub/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ query: "nginx upstream 3000", scope: "all", maxResults: 5 }),
    });
    const searchJson = await searchRes.json();

    const { tools, service } = makePluginApi(clientDir, {
      sharing: {
        enabled: true,
        role: "client",
        client: {
          hubAddress: `127.0.0.1:${port}`,
          userToken,
        },
      },
      telemetry: { enabled: false },
    });

    return {
      clientDir,
      hubDir,
      tools,
      service,
      hubStore,
      hubServer,
      remoteHitId: searchJson.hits[0].remoteHitId as string,
    };
  }

  async function teardownNetworkMemoryDetailHarness(harness: Awaited<ReturnType<typeof setupNetworkMemoryDetailHarness>>) {
    await harness.service?.stop?.();
    await harness.hubServer.stop();
    harness.hubStore.close();
    fs.rmSync(harness.clientDir, { recursive: true, force: true });
    fs.rmSync(harness.hubDir, { recursive: true, force: true });
  }

  it("network_memory_detail should fetch hub detail via config fallback", async () => {
    const harness = await setupNetworkMemoryDetailHarness();

    try {
      const detailTool = harness.tools.get("network_memory_detail");
      expect(detailTool).toBeDefined();

      const result = await detailTool.execute("call-network-detail", { remoteHitId: harness.remoteHitId }, { agentId: "main" });
      expect(result.details.remoteHitId).toBe(harness.remoteHitId);
      expect(result.details.content).toContain("proxy_pass");
      expect(result.details.summary).toContain("nginx upstream");
      expect(result.details.source.role).toBe("assistant");
    } finally {
      await teardownNetworkMemoryDetailHarness(harness);
    }
  });
});

describe("Integration: network team info tool", () => {
  async function setupNetworkTeamInfoHarness() {
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-network-team-client-"));
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-network-team-hub-"));
    const port = 19400 + Math.floor(Math.random() * 1000);
    const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog as any);
    const hubServer = new HubServer({
      store: hubStore,
      log: noopLog as any,
      config: {
        sharing: {
          enabled: true,
          role: "hub",
          hub: {
            port,
            teamName: "Team Info Test",
            teamToken: "team-info-secret",
          },
        },
      } as any,
      dataDir: hubDir,
    } as any);

    await hubServer.start();
    const authState = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
    const userToken = authState.bootstrapAdminToken as string;
    const userId = authState.bootstrapAdminUserId as string;

    hubStore.upsertHubGroup({
      id: "group-devops",
      name: "DevOps",
      description: "DevOps team",
      createdAt: 1,
    });
    hubStore.addHubGroupMember("group-devops", userId, 1);

    const { tools, service } = makePluginApi(clientDir, {
      sharing: {
        enabled: true,
        role: "client",
        client: {
          hubAddress: `127.0.0.1:${port}`,
          userToken,
        },
      },
      telemetry: { enabled: false },
    });

    return {
      clientDir,
      hubDir,
      tools,
      service,
      hubStore,
      hubServer,
    };
  }

  async function teardownNetworkTeamInfoHarness(harness: Awaited<ReturnType<typeof setupNetworkTeamInfoHarness>>) {
    await harness.service?.stop?.();
    await harness.hubServer.stop();
    harness.hubStore.close();
    fs.rmSync(harness.clientDir, { recursive: true, force: true });
    fs.rmSync(harness.hubDir, { recursive: true, force: true });
  }

  it("network_team_info should report hub connection, user, and groups", async () => {
    const harness = await setupNetworkTeamInfoHarness();

    try {
      const teamInfoTool = harness.tools.get("network_team_info");
      expect(teamInfoTool).toBeDefined();

      const result = await teamInfoTool.execute("call-team-info", {}, { agentId: "main" });
      expect(result.details.connected).toBe(true);
      expect(result.details.hubUrl).toContain("127.0.0.1:");
      expect(result.details.user.username).toBe("admin");
      expect(result.details.user.role).toBe("admin");
      expect(result.details.user.groups.map((group: any) => group.name)).toEqual(["DevOps"]);
    } finally {
      await teardownNetworkTeamInfoHarness(harness);
    }
  });
});

describe("Integration: hub skill sync", () => {
  async function setupSkillSyncHarness() {
    const publisherDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-skill-publisher-"));
    const pullerDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-skill-puller-"));
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-skill-hub-"));
    const port = 19500 + Math.floor(Math.random() * 1000);
    const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog as any);
    const hubServer = new HubServer({
      store: hubStore,
      log: noopLog as any,
      config: {
        sharing: {
          enabled: true,
          role: "hub",
          hub: {
            port,
            teamName: "Skill Sync Test",
            teamToken: "skill-sync-secret",
          },
        },
      } as any,
      dataDir: hubDir,
    } as any);

    await hubServer.start();
    const authState = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
    const userToken = authState.bootstrapAdminToken as string;

    const skillDir = path.join(publisherDir, "skills-store", "docker-compose-deploy");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
    fs.mkdirSync(path.join(skillDir, "evals"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Docker Compose Deploy\nUse scripts/deploy.sh", "utf8");
    fs.writeFileSync(path.join(skillDir, "scripts", "deploy.sh"), "#!/bin/bash\ndocker compose up -d\n", "utf8");
    fs.writeFileSync(path.join(skillDir, "references", "docker-compose.yml"), "services:\n  app: {}\n", "utf8");
    fs.writeFileSync(path.join(skillDir, "evals", "evals.json"), JSON.stringify({
      skill_name: "docker-compose-deploy",
      evals: [{ id: 1, prompt: "deploy app", expectations: ["compose", "up -d"] }],
    }), "utf8");

    const publisherStore = new SqliteStore(path.join(publisherDir, "memos-local", "memos.db"), noopLog as any);
    publisherStore.insertSkill({
      id: "skill-local-1",
      name: "docker-compose-deploy",
      description: "Deploy with docker compose",
      version: 2,
      status: "active",
      tags: JSON.stringify(["docker", "deploy"]),
      sourceType: "manual",
      dirPath: skillDir,
      installed: 0,
      owner: "agent:main",
      visibility: "private",
      qualityScore: 0.88,
      createdAt: 1,
      updatedAt: 1,
    });
    publisherStore.insertSkillVersion({
      id: "skill-version-local-1",
      skillId: "skill-local-1",
      version: 2,
      content: "# Docker Compose Deploy\nUse scripts/deploy.sh",
      changelog: "initial",
      changeSummary: "initial",
      upgradeType: "create",
      sourceTaskId: null,
      metrics: "{}",
      qualityScore: 0.88,
      createdAt: 1,
    });
    publisherStore.close();

    const publisher = makePluginApi(publisherDir, {
      sharing: {
        enabled: true,
        role: "client",
        client: {
          hubAddress: `127.0.0.1:${port}`,
          userToken,
        },
      },
      telemetry: { enabled: false },
    });

    const puller = makePluginApi(pullerDir, {
      sharing: {
        enabled: true,
        role: "client",
        client: {
          hubAddress: `127.0.0.1:${port}`,
          userToken,
        },
      },
      telemetry: { enabled: false },
    });

    const pullerStore = new SqliteStore(path.join(pullerDir, "memos-local", "memos.db"), noopLog as any);

    return {
      publisherDir,
      pullerDir,
      hubDir,
      publisher,
      puller,
      pullerStore,
      hubStore,
      hubServer,
    };
  }

  async function teardownSkillSyncHarness(harness: Awaited<ReturnType<typeof setupSkillSyncHarness>>) {
    await harness.publisher.service?.stop?.();
    await harness.puller.service?.stop?.();
    harness.pullerStore.close();
    await harness.hubServer.stop();
    harness.hubStore.close();
    fs.rmSync(harness.publisherDir, { recursive: true, force: true });
    fs.rmSync(harness.pullerDir, { recursive: true, force: true });
    fs.rmSync(harness.hubDir, { recursive: true, force: true });
  }

  it("skill_publish and network_skill_pull should round-trip a bundle through the hub", async () => {
    const harness = await setupSkillSyncHarness();

    try {
      const publishTool = harness.publisher.tools.get("skill_publish");
      const pullTool = harness.puller.tools.get("network_skill_pull");
      expect(publishTool).toBeDefined();
      expect(pullTool).toBeDefined();

      const publishResult = await publishTool.execute("call-skill-publish", { skillId: "skill-local-1", scope: "public" }, { agentId: "main" });
      expect(publishResult.details.publishedToHub).toBe(true);
      expect(publishResult.details.hubSkillId).toBeTruthy();

      const searchTool = harness.puller.tools.get("skill_search");
      const searchResult = await searchTool.execute("call-skill-search", { query: "docker compose deploy", scope: "all" }, { agentId: "main" });
      expect(searchResult.details.hub.hits.length).toBeGreaterThan(0);
      expect(searchResult.details.hub.hits[0].name).toContain("docker-compose-deploy");

      const pulled = await pullTool.execute("call-skill-pull", { skillId: searchResult.details.hub.hits[0].skillId }, { agentId: "main" });
      expect(pulled.details.pulled).toBe(true);
      expect(pulled.details.localSkillId).toBeTruthy();

      const localSkill = harness.pullerStore.getSkill(pulled.details.localSkillId);
      expect(localSkill).not.toBeNull();
      expect(localSkill!.name).toContain("docker-compose-deploy");
      expect(fs.existsSync(path.join(localSkill!.dirPath, "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(localSkill!.dirPath, "scripts", "deploy.sh"))).toBe(true);
      expect(fs.existsSync(path.join(localSkill!.dirPath, "references", "docker-compose.yml"))).toBe(true);
    } finally {
      await teardownSkillSyncHarness(harness);
    }
  });
});

describe("Integration: evidence anti-writeback", () => {
  it("should not store evidence wrapper blocks in memory", async () => {
    plugin.onConversationTurn([
      { role: "assistant", content: "Based on [STORED_MEMORY]old data about port 3000[/STORED_MEMORY] the answer is port 8443." },
    ], "session-test");

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "old data port 3000" })) as any;

    for (const hit of result.hits) {
      expect(hit.original_excerpt).not.toContain("[STORED_MEMORY]");
      expect(hit.original_excerpt).not.toContain("old data about port 3000");
    }
  });
});
