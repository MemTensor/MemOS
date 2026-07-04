import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

interface HarnessResult {
  recallSearchCalls: Array<{ query: string }>;
  hookHandler: ((event: unknown, ctx: unknown) => Promise<unknown> | unknown) | null;
}

async function buildPlugin(autoRecall: Record<string, unknown> | undefined): Promise<HarnessResult> {
  const recallSearchCalls: Array<{ query: string }> = [];

  vi.doMock("../src/config", () => ({
    buildContext: () => ({
      stateDir: "/tmp/memos-cron-gate",
      workspaceDir: "/tmp/memos-cron-gate/workspace",
      log: { debug() {}, info() {}, warn() {}, error() {} },
      openclawAPI: undefined,
      config: {
        storage: { dbPath: "/tmp/memos-cron-gate/memos.db" },
        capture: { evidenceWrapperTag: "STORED_MEMORY" },
        telemetry: {},
        sharing: { enabled: false, role: "client", hub: { port: 18800, teamName: "", teamToken: "" }, client: { hubAddress: "", userToken: "" }, capabilities: {} },
        autoRecall,
      },
    }),
  }));

  vi.doMock("../src/storage/ensure-binding", () => ({ ensureSqliteBinding: () => {} }));
  vi.doMock("../src/storage/sqlite", () => ({
    SqliteStore: class {
      recordToolCall() {}
      recordApiLog() {}
      getTask() { return null; }
      getChunksByTask() { return []; }
      getSkillsByTask() { return []; }
      listLocalSharedTasks() { return []; }
      getClientHubConnection() { return null; }
      getChunk() { return null; }
      getChunkForOwners() { return null; }
      getNeighborChunks() { return []; }
      getSkill() { return null; }
      getLatestSkillVersion() { return null; }
      close() {}
    },
  }));

  vi.doMock("../src/embedding", () => ({ Embedder: class { provider = "openclaw"; constructor() {} async embed() { return []; } } }));

  vi.doMock("../src/ingest/worker", () => ({
    IngestWorker: class {
      getTaskProcessor() { return { onTaskCompleted() {} }; }
      enqueue() {}
      async flush() {}
    },
  }));

  vi.doMock("../src/recall/engine", () => ({
    RecallEngine: class {
      async search(input: { query: string }) {
        recallSearchCalls.push({ query: input.query });
        return { hits: [], meta: {} };
      }
      async searchSkills() { return []; }
    },
  }));

  vi.doMock("../src/ingest/providers", () => ({
    Summarizer: class {
      constructor() {}
      async filterRelevant() { return null; }
    },
  }));

  vi.doMock("../src/viewer/server", () => ({
    ViewerServer: class {
      async start() { return "http://127.0.0.1:18799"; }
      stop() {}
      getResetToken() { return "tok"; }
    },
  }));

  vi.doMock("../src/hub/server", () => ({
    HubServer: class {
      async start() { return "http://127.0.0.1:18800"; }
      async stop() {}
    },
  }));

  vi.doMock("../src/client/hub", () => ({
    hubGetMemoryDetail: async () => ({}),
    hubRequestJson: async () => ({}),
    hubSearchMemories: async () => ({ hits: [], meta: {} }),
    hubSearchSkills: async () => ({ hits: [] }),
    resolveHubClient: async () => ({ hubUrl: "", userToken: "", userId: "" }),
  }));

  vi.doMock("../src/client/connector", () => ({
    getHubStatus: async () => ({ connected: false }),
    connectToHub: async () => ({ username: "test", userId: "test" }),
  }));

  vi.doMock("../src/client/skill-sync", () => ({
    fetchHubSkillBundle: async () => ({}),
    publishSkillBundleToHub: async () => ({}),
    restoreSkillBundleFromHub: () => ({}),
    unpublishSkillBundleFromHub: async () => ({}),
  }));

  vi.doMock("../src/skill/evolver", () => ({
    SkillEvolver: class {
      onSkillEvolved: unknown = null;
      async onTaskCompleted() {}
      async recoverOrphanedTasks() { return 0; }
    },
  }));

  vi.doMock("../src/skill/installer", () => ({
    SkillInstaller: class {
      install() { return { message: "" }; }
      getCompanionManifest() { return null; }
      readCompanionFile() { return { error: "n/a" } as any; }
    },
  }));

  vi.doMock("../src/skill/bundled-memory-guide", () => ({ MEMORY_GUIDE_SKILL_MD: "# mock" }));

  vi.doMock("../src/telemetry", () => ({
    Telemetry: class {
      trackError() {}
      trackToolCalled() {}
      trackAutoRecall() {}
      trackMemoryIngested() {}
      trackSkillInstalled() {}
      trackSkillEvolved() {}
      trackPluginStarted() {}
      trackViewerOpened() {}
      async shutdown() {}
    },
  }));

  vi.doMock("../src/capture", () => ({
    captureMessages: () => [],
    stripInboundMetadata: (s: string) => s,
  }));

  let hookHandler: HarnessResult["hookHandler"] = null;
  const fakeApi = {
    id: "memos-local-openclaw-plugin",
    pluginConfig: {},
    config: {},
    resolvePath: () => "/tmp/memos-cron-gate",
    logger: { info() {}, warn() {} },
    registerTool: () => {},
    registerMemoryCapability: () => {},
    registerService: () => {},
    on: (eventName: string, handler: (e: unknown, ctx: unknown) => unknown) => {
      if (eventName === "before_prompt_build") hookHandler = handler as HarnessResult["hookHandler"];
    },
  } as any;

  const pluginModule = await import("../plugin-impl");
  pluginModule.default.register(fakeApi);

  return { recallSearchCalls, hookHandler };
}

describe("before_prompt_build cron-session gate (GitHub #1311)", () => {
  it("skips engine.search for cron sessionKey when excludeCron defaults to true", async () => {
    const { recallSearchCalls, hookHandler } = await buildPlugin(undefined);
    expect(hookHandler).toBeTypeOf("function");

    const result = await hookHandler!(
      { prompt: "Trade the morning open and report PnL." },
      { agentId: "main", sessionKey: "agent:main:cron:job-abc" },
    );

    expect(result).toBeUndefined();
    expect(recallSearchCalls).toHaveLength(0);
  });

  it("still runs engine.search for non-cron chat sessionKey", async () => {
    const { recallSearchCalls, hookHandler } = await buildPlugin(undefined);

    await hookHandler!(
      { prompt: "Trade the morning open and report PnL." },
      { agentId: "main", sessionKey: "agent:main:chat:hello" },
    );

    expect(recallSearchCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("runs engine.search for cron sessions when excludeCron=false", async () => {
    const { recallSearchCalls, hookHandler } = await buildPlugin({
      excludeCron: false,
    });

    await hookHandler!(
      { prompt: "Trade the morning open and report PnL." },
      { agentId: "main", sessionKey: "agent:main:cron:job-abc" },
    );

    expect(recallSearchCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("honours excludeSessionKeyPatterns", async () => {
    const { recallSearchCalls, hookHandler } = await buildPlugin({
      excludeCron: false,
      excludeSessionKeyPatterns: ["^agent:debug:"],
    });

    await hookHandler!(
      { prompt: "Trade the morning open and report PnL." },
      { agentId: "main", sessionKey: "agent:debug:gateway:hello" },
    );

    expect(recallSearchCalls).toHaveLength(0);
  });
});
