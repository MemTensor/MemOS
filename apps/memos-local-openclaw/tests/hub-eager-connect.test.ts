import { afterEach, describe, expect, it, vi } from "vitest";

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

/**
 * Regression coverage for GitHub issue #1612:
 * "memos-local-openclaw-plugin: ctx.registerTools() never called in QClaw
 * desktop app context"
 *
 * Hosts such as the QClaw desktop app load the plugin without calling
 * `service.start()` and may not reliably tick `setTimeout(0)`. The plugin
 * must still attempt the Hub client connection so team sharing works.
 *
 * These tests verify:
 *   1. When `service.start()` is never called, `connectToHub` is still
 *      invoked (eager hub connect).
 *   2. When sharing is disabled or the role is not "client", no connection
 *      attempt is made.
 *   3. When both `service.start()` and the eager path run, the connection
 *      is attempted exactly once (idempotency guard).
 */
async function loadPluginWithMocks(opts: {
  sharingConfig: any;
  connectToHubImpl?: (...args: unknown[]) => Promise<unknown>;
  captureService?: (service: any) => void;
}): Promise<{ connectSpy: ReturnType<typeof vi.fn> }> {
  const connectSpy = vi.fn(opts.connectToHubImpl ?? (async () => ({ userId: "u1", username: "tester" })));

  vi.doMock("../src/config", () => ({
    buildContext: () => ({
      stateDir: "/tmp/memos-eager-hub",
      workspaceDir: "/tmp/memos-eager-hub/workspace",
      log: noopLog,
      openclawAPI: undefined,
      config: {
        storage: { dbPath: "/tmp/memos-eager-hub/memos.db" },
        capture: { evidenceWrapperTag: "STORED_MEMORY" },
        telemetry: {},
        sharing: opts.sharingConfig,
      },
    }),
  }));

  vi.doMock("../src/storage/sqlite", () => ({
    SqliteStore: class {
      recordToolCall() {}
      recordApiLog() {}
      close() {}
    },
  }));

  vi.doMock("../src/embedding", () => ({
    Embedder: class { provider = "mock"; },
  }));

  vi.doMock("../src/ingest/worker", () => ({
    IngestWorker: class {
      getTaskProcessor() { return { onTaskCompleted() {} }; }
      enqueue() {}
      async flush() {}
    },
  }));

  vi.doMock("../src/recall/engine", () => ({
    RecallEngine: class {
      async search() { return { hits: [], meta: {} }; }
      async searchSkills() { return []; }
    },
  }));

  vi.doMock("../src/ingest/providers", () => ({
    Summarizer: class { async filterRelevant() { return null; } },
  }));

  vi.doMock("../src/viewer/server", () => ({
    ViewerServer: class {
      async start() { return "http://127.0.0.1:18799"; }
      stop() {}
      getResetToken() { return "token"; }
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
    connectToHub: connectSpy,
    getHubStatus: async () => ({ connected: false }),
  }));

  vi.doMock("../src/client/skill-sync", () => ({
    fetchHubSkillBundle: async () => ({}),
    publishSkillBundleToHub: async () => ({}),
    restoreSkillBundleFromHub: () => ({}),
    unpublishSkillBundleFromHub: async () => ({}),
  }));

  vi.doMock("../src/skill/evolver", () => ({
    SkillEvolver: class { async onTaskCompleted() {} async recoverOrphanedTasks() { return 0; } },
  }));

  vi.doMock("../src/skill/installer", () => ({ SkillInstaller: class {} }));
  vi.doMock("../src/skill/bundled-memory-guide", () => ({ MEMORY_GUIDE_SKILL_MD: "# mock" }));

  vi.doMock("../src/telemetry", () => ({
    Telemetry: class {
      trackToolCalled() {}
      trackAutoRecall() {}
      trackMemoryIngested() {}
      trackSkillInstalled() {}
      trackPluginStarted() {}
      trackViewerOpened() {}
      trackSkillEvolved() {}
      async shutdown() {}
    },
  }));

  const pluginModule = await import("../plugin-impl");
  pluginModule.default.register({
    pluginConfig: {},
    config: {},
    resolvePath: () => "/tmp/memos-eager-hub",
    logger: { info() {}, warn() {} },
    registerTool: () => {},
    registerMemoryCapability: () => {},
    registerService: (service: any) => { opts.captureService?.(service); },
    on: () => {},
  } as any);

  return { connectSpy };
}

describe("eager hub connection (GitHub #1612)", () => {
  it("attempts to connect to the hub at register-time when sharing is enabled in client role, even if service.start() is never called", async () => {
    const { connectSpy } = await loadPluginWithMocks({
      sharingConfig: {
        enabled: true,
        role: "client",
        client: { hubAddress: "127.0.0.1:18912", userToken: "tk" },
      },
    });

    // Allow the fire-and-forget eager connectToHub() promise to settle
    // without depending on setTimeout — the eager call runs as part of
    // register(), so the next microtask flush is enough.
    await Promise.resolve();
    await Promise.resolve();

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("does not attempt to connect when sharing is disabled", async () => {
    const { connectSpy } = await loadPluginWithMocks({
      sharingConfig: {
        enabled: false,
        role: "client",
        client: { hubAddress: "127.0.0.1:18912", userToken: "tk" },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("does not attempt to connect when running in hub role", async () => {
    const { connectSpy } = await loadPluginWithMocks({
      sharingConfig: {
        enabled: true,
        role: "hub",
        hub: { port: 18912, teamName: "T", teamToken: "tk" },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("only attempts the hub connection once when both the eager path and service.start() run", async () => {
    let capturedService: any;
    const { connectSpy } = await loadPluginWithMocks({
      sharingConfig: {
        enabled: true,
        role: "client",
        client: { hubAddress: "127.0.0.1:18912", userToken: "tk" },
      },
      captureService: (s) => { capturedService = s; },
    });

    // Eager connect runs first (already initiated at register-time).
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedService).toBeDefined();
    await capturedService.start();

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});
