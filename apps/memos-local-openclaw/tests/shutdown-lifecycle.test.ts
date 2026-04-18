import { describe, it, expect, vi, afterEach } from "vitest";

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("shutdown lifecycle", () => {
  it("initPlugin.shutdown should wait for worker.flush before closing the store", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    class MockStore {
      close(): void {
        events.push("close");
      }
    }

    class MockWorker {
      enqueue(): void {}
      flush(): Promise<void> {
        events.push("flush");
        return gate;
      }
    }

    vi.doMock("../src/storage/sqlite", () => ({ SqliteStore: MockStore }));
    vi.doMock("../src/ingest/worker", () => ({ IngestWorker: MockWorker }));
    vi.doMock("../src/embedding", () => ({ Embedder: class { provider = "mock"; } }));
    vi.doMock("../src/recall/engine", () => ({ RecallEngine: class {} }));
    vi.doMock("../src/capture", () => ({ captureMessages: () => [] }));
    vi.doMock("../src/tools", () => ({
      createMemorySearchTool: () => ({ name: "memory_search" }),
      createMemoryTimelineTool: () => ({ name: "memory_timeline" }),
      createMemoryGetTool: () => ({ name: "memory_get" }),
      createNetworkMemoryDetailTool: () => ({ name: "network_memory_detail" }),
    }));

    const { initPlugin } = await import("../src/index");
    const plugin = initPlugin({ stateDir: "/tmp/memos-shutdown-test", log: noopLog as any });

    const shutdownPromise = Promise.resolve(plugin.shutdown() as any);
    expect(events).toEqual(["flush"]);

    release();
    await shutdownPromise;
    expect(events).toEqual(["flush", "close"]);
  });

  it("plugin service stop should wait for worker.flush before closing the store", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    class MockStore {
      close(): void {
        events.push("close");
      }
    }

    class MockWorker {
      enqueue(): void {}
      flush(): Promise<void> {
        events.push("flush");
        return gate;
      }
      getTaskProcessor() {
        return { onTaskCompleted: () => {} };
      }
    }

    class MockViewer {
      async start(): Promise<string> { return "http://127.0.0.1:18799"; }
      stop(): void { events.push("viewer-stop"); }
      getResetToken(): string { return "token"; }
    }

    let registeredService: { stop: () => Promise<void> | void } | undefined;

    vi.doMock("../src/storage/sqlite", () => ({ SqliteStore: MockStore }));
    vi.doMock("../src/ingest/worker", () => ({ IngestWorker: MockWorker }));
    vi.doMock("../src/embedding", () => ({ Embedder: class { provider = "mock"; } }));
    vi.doMock("../src/recall/engine", () => ({ RecallEngine: class { async search() { return { hits: [], meta: {} }; } async searchSkills() { return []; } } }));
    vi.doMock("../src/capture", () => ({ captureMessages: () => [], stripInboundMetadata: (s: string) => s }));
    vi.doMock("../src/viewer/server", () => ({ ViewerServer: MockViewer }));
    vi.doMock("../src/hub/server", () => ({ HubServer: class { async start() { return ""; } stop() {} } }));
    vi.doMock("../src/client/hub", () => ({ hubGetMemoryDetail: async () => ({}), hubRequestJson: async () => ({}), hubSearchMemories: async () => ({ hits: [] }), hubSearchSkills: async () => ({ hits: [] }), resolveHubClient: async () => ({}) }));
    vi.doMock("../src/client/connector", () => ({ getHubStatus: async () => ({ connected: false }) }));
    vi.doMock("../src/client/skill-sync", () => ({ fetchHubSkillBundle: async () => ({}), publishSkillBundleToHub: async () => ({}), restoreSkillBundleFromHub: () => ({}) }));
    vi.doMock("../src/skill/evolver", () => ({ SkillEvolver: class { async onTaskCompleted() {} } }));
    vi.doMock("../src/skill/installer", () => ({ SkillInstaller: class { install() { return { message: "ok" }; } } }));
    vi.doMock("../src/ingest/providers", () => ({ Summarizer: class { async filterRelevant() { return null; } } }));
    vi.doMock("../src/skill/bundled-memory-guide", () => ({ MEMORY_GUIDE_SKILL_MD: "# mock" }));
    vi.doMock("../src/telemetry", () => ({ Telemetry: class { trackToolCalled() {} trackAutoRecall() {} trackMemoryIngested() {} trackSkillInstalled() {} trackPluginStarted() {} async shutdown() {} } }));

    const pluginModule = await import("../plugin-impl");
    const plugin = pluginModule.default;
    plugin.register({
      pluginConfig: {},
      config: {},
      resolvePath: () => "/tmp/memos-service-stop",
      logger: noopLog,
      registerTool: () => {},
      registerMemoryCapability: () => {},
      registerService: (service: any) => { registeredService = service; },
      on: () => {},
    } as any);

    expect(registeredService).toBeDefined();
    const stopPromise = Promise.resolve(registeredService!.stop() as any);
    expect(events).toContain("flush");
    expect(events).not.toContain("close");

    release();
    await stopPromise;
    expect(events).toContain("viewer-stop");
    expect(events[events.length - 1]).toBe("close");
  });
});
