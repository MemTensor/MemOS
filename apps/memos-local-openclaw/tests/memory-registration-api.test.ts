/**
 * Regression tests for issue #1559 — OpenClaw 2026.3.31 renamed the memory
 * registration API from `registerMemoryCapability({ promptBuilder })` to
 * `registerMemoryPromptSection(builder)`. The plugin must:
 *
 *   1. Prefer the new API when the host exposes it (OpenClaw 2026.3.31+).
 *   2. Fall back to the legacy API when only that is available (older gateways).
 *   3. Fail loudly (log at error + throw) when neither method exists — so the
 *      rest of register() does not spin up in a permanently broken state and
 *      operators see the incompatibility immediately in production dashboards.
 *      Falls back to `logger.warn` when the host lacks `.error`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

function setupMocks() {
  vi.doMock("../src/config", () => ({
    buildContext: () => ({
      stateDir: "/tmp/memos-openclaw-reg",
      workspaceDir: "/tmp/memos-openclaw-reg/workspace",
      log: { debug() {}, info() {}, warn() {}, error() {} },
      openclawAPI: undefined,
      config: {
        storage: { dbPath: "/tmp/memos-openclaw-reg/memos.db" },
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
  vi.doMock("../src/storage/ensure-binding", () => ({ ensureSqliteBinding: () => {} }));
  vi.doMock("../src/embedding", () => ({
    Embedder: class {
      provider = "openclaw";
      constructor(_cfg: unknown, _log: unknown, _openclaw: unknown) {}
      async embed() { return []; }
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
      constructor(_cfg: unknown, _log: unknown, _openclaw: unknown) {}
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
    unpublishSkillBundleFromHub: async () => ({}),
  }));
  vi.doMock("../src/skill/evolver", () => ({ SkillEvolver: class { async onTaskCompleted() {} } }));
  vi.doMock("../src/skill/installer", () => ({ SkillInstaller: class {} }));
  vi.doMock("../src/skill/bundled-memory-guide", () => ({ MEMORY_GUIDE_SKILL_MD: "# mock" }));
  vi.doMock("../src/telemetry", () => ({ Telemetry: class {
    trackToolCalled() {}
    trackAutoRecall() {}
    trackMemoryIngested() {}
    trackSkillInstalled() {}
    trackSkillEvolved() {}
    trackPluginStarted() {}
    trackError() {}
    trackViewerOpened() {}
    async shutdown() {}
  }}));
  vi.doMock("../src/capture", () => ({
    captureMessages: () => {},
    stripInboundMetadata: (s: string) => s,
  }));
}

function makeBaseApi(overrides: Record<string, unknown>) {
  return {
    id: "memos-local-openclaw-plugin",
    pluginConfig: {},
    config: {},
    resolvePath: () => "/tmp/memos-openclaw-reg",
    logger: { info() {}, warn() {}, error() {} },
    registerTool: () => {},
    registerService: () => {},
    on: () => {},
    ...overrides,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("issue #1559 — memory registration API compatibility", () => {
  it("prefers registerMemoryPromptSection (OpenClaw 2026.3.31+) over the legacy method", async () => {
    setupMocks();
    const registerMemoryPromptSection = vi.fn();
    const registerMemoryCapability = vi.fn();

    const pluginModule = await import("../plugin-impl");
    pluginModule.default.register(makeBaseApi({
      registerMemoryPromptSection,
      registerMemoryCapability,
    }) as any);

    expect(registerMemoryPromptSection).toHaveBeenCalledTimes(1);
    expect(registerMemoryPromptSection.mock.calls[0][0]).toBeInstanceOf(Function);
    expect(registerMemoryCapability).not.toHaveBeenCalled();
  });

  it("falls back to registerMemoryCapability when the new API is missing (legacy OpenClaw)", async () => {
    setupMocks();
    const registerMemoryCapability = vi.fn();

    const pluginModule = await import("../plugin-impl");
    pluginModule.default.register(makeBaseApi({
      registerMemoryCapability,
    }) as any);

    expect(registerMemoryCapability).toHaveBeenCalledTimes(1);
    const capability = registerMemoryCapability.mock.calls[0][0];
    expect(capability).toBeTypeOf("object");
    expect(capability.promptBuilder).toBeInstanceOf(Function);
  });

  it("logs at error level and throws when neither memory-registration method exists", async () => {
    setupMocks();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();

    const pluginModule = await import("../plugin-impl");
    expect(() => {
      pluginModule.default.register(makeBaseApi({
        logger: { info, warn, error },
      }) as any);
    }).toThrow(/registerMemoryPromptSection|registerMemoryCapability/);

    // The misconfiguration is fatal for recall, so it must escalate to error rather
    // than being buried in a warn log where operators are more likely to miss it,
    // and throwing prevents register() from proceeding to spin up stores/workers/tools
    // in a state where the plugin looks healthy but recall is silently dead.
    expect(error).toHaveBeenCalled();
    const errorMsg = error.mock.calls.map((c) => String(c[0])).join(" ");
    expect(errorMsg).toMatch(/registerMemoryPromptSection|registerMemoryCapability/);
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/registerMemoryPromptSection|registerMemoryCapability/),
    );
  });

  it("falls back to warn (and still throws) when the host logger lacks an error method", async () => {
    setupMocks();
    const warn = vi.fn();

    const pluginModule = await import("../plugin-impl");
    expect(() => {
      pluginModule.default.register(makeBaseApi({
        // Simulate an older host whose HostLogger shape has no `error`.
        logger: { info() {}, warn },
      }) as any);
    }).toThrow(/registerMemoryPromptSection|registerMemoryCapability/);

    expect(warn).toHaveBeenCalled();
    const warnMsg = warn.mock.calls.map((c) => String(c[0])).join(" ");
    expect(warnMsg).toMatch(/registerMemoryPromptSection|registerMemoryCapability/);
  });
});
