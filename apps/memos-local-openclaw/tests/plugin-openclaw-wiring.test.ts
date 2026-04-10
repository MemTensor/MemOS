import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("plugin-impl OpenClaw wiring", () => {
  it("passes ctx.openclawAPI into the main Embedder and Summarizer instances", async () => {
    const openclawAPI = {
      embed: vi.fn(),
      complete: vi.fn(),
    };

    let embedderOpenClawArg: unknown;
    let summarizerOpenClawArg: unknown;

    vi.doMock("../src/config", () => ({
      buildContext: () => ({
        stateDir: "/tmp/memos-openclaw-wiring",
        workspaceDir: "/tmp/memos-openclaw-wiring/workspace",
        log: { debug() {}, info() {}, warn() {}, error() {} },
        openclawAPI,
        config: {
          storage: { dbPath: "/tmp/memos-openclaw-wiring/memos.db" },
          capture: { evidenceWrapperTag: "STORED_MEMORY" },
          telemetry: {},
          embedding: { provider: "openclaw", capabilities: { hostEmbedding: true } },
          summarizer: { provider: "openclaw", capabilities: { hostCompletion: true } },
          sharing: { enabled: false, role: "client", hub: { port: 18800, teamName: "", teamToken: "" }, client: { hubAddress: "", userToken: "" }, capabilities: { hostEmbedding: true, hostCompletion: true } },
        },
      }),
    }));

    vi.doMock("../src/storage/sqlite", () => ({ SqliteStore: class {
      recordToolCall() {}
      recordApiLog() {}
      close() {}
    }}));

    vi.doMock("../src/embedding", () => ({
      Embedder: class {
        provider = "openclaw";
        constructor(_cfg: unknown, _log: unknown, openclaw: unknown) {
          embedderOpenClawArg = openclaw;
        }
      },
    }));

    vi.doMock("../src/ingest/worker", () => ({ IngestWorker: class {
      getTaskProcessor() { return { onTaskCompleted() {} }; }
      enqueue() {}
      async flush() {}
    }}));

    vi.doMock("../src/recall/engine", () => ({ RecallEngine: class {
      async search() { return { hits: [], meta: {} }; }
      async searchSkills() { return []; }
    }}));

    vi.doMock("../src/ingest/providers", () => ({
      Summarizer: class {
        constructor(_cfg: unknown, _log: unknown, openclaw: unknown) {
          summarizerOpenClawArg = openclaw;
        }
        async filterRelevant() { return null; }
      },
    }));

    vi.doMock("../src/viewer/server", () => ({ ViewerServer: class {
      async start() { return "http://127.0.0.1:18799"; }
      stop() {}
      getResetToken() { return "token"; }
    }}));

    vi.doMock("../src/hub/server", () => ({ HubServer: class {
      async start() { return "http://127.0.0.1:18800"; }
      async stop() {}
    }}));

    vi.doMock("../src/client/hub", () => ({
      hubGetMemoryDetail: async () => ({}),
      hubRequestJson: async () => ({}),
      hubSearchMemories: async () => ({ hits: [], meta: {} }),
      hubSearchSkills: async () => ({ hits: [] }),
      resolveHubClient: async () => ({ hubUrl: "", userToken: "", userId: "" }),
    }));

    vi.doMock("../src/client/connector", () => ({ getHubStatus: async () => ({ connected: false }) }));
    vi.doMock("../src/client/skill-sync", () => ({
      fetchHubSkillBundle: async () => ({}),
      publishSkillBundleToHub: async () => ({}),
      restoreSkillBundleFromHub: () => ({}),
    }));
    vi.doMock("../src/skill/evolver", () => ({ SkillEvolver: class { async onTaskCompleted() {} } }));
    vi.doMock("../src/skill/installer", () => ({ SkillInstaller: class {} }));
    vi.doMock("../src/skill/bundled-memory-guide", () => ({ MEMORY_GUIDE_SKILL_MD: "# mock" }));
    vi.doMock("../src/telemetry", () => ({ Telemetry: class {
      trackToolCalled() {}
      trackAutoRecall() {}
      trackMemoryIngested() {}
      trackSkillInstalled() {}
      trackPluginStarted() {}
      async shutdown() {}
    }}));
    vi.doMock("../src/hybrid", () => ({ deduplicateHits: (hits: unknown[]) => hits, stripInboundMetadata: (s: string) => s }));

    const pluginModule = await import("../plugin-impl");
    pluginModule.default.register({
      pluginConfig: {},
      config: {},
      resolvePath: () => "/tmp/memos-openclaw-wiring",
      logger: { info() {}, warn() {} },
      registerTool: () => {},
      registerMemoryCapability: () => {},
      registerService: () => {},
      on: () => {},
    } as any);

    expect(embedderOpenClawArg).toBe(openclawAPI);
    expect(summarizerOpenClawArg).toBe(openclawAPI);
  });
});
