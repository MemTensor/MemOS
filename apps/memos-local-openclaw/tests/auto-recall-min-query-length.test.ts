import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { MemosLocalConfig } from "../src/types";

type AutoRecallHook = (
  event: { prompt?: string; messages?: unknown[] },
  hookCtx?: { agentId?: string; sessionKey?: string },
) => Promise<unknown>;

const noopLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

async function registerPluginAndGetAutoRecallHook(opts: {
  config: Partial<MemosLocalConfig>;
  engineSearch: ReturnType<typeof vi.fn>;
}): Promise<AutoRecallHook> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-auto-recall-min-query-"));
  const handlers = new Map<string, AutoRecallHook>();

  vi.doMock("../src/config", () => ({
    buildContext: () => ({
      stateDir: tmpDir,
      workspaceDir: path.join(tmpDir, "workspace"),
      config: {
        storage: { dbPath: path.join(tmpDir, "memos.db") },
        capture: { evidenceWrapperTag: "STORED_MEMORY" },
        telemetry: {},
        sharing: {
          enabled: false,
          role: "client",
          hub: { port: 18800, teamName: "", teamToken: "" },
          client: { hubAddress: "", userToken: "" },
          capabilities: { hostEmbedding: false, hostCompletion: false, hostSkill: false },
        },
        skillEvolution: { autoRecallSkills: false },
        ...opts.config,
      },
      log: noopLog,
    }),
  }));
  vi.doMock("../src/storage/ensure-binding", () => ({ ensureSqliteBinding: () => {} }));
  vi.doMock("../src/storage/sqlite", () => ({ SqliteStore: class {
    recordToolCall() {}
    recordApiLog() {}
    close() {}
  } }));
  vi.doMock("../src/embedding", () => ({ Embedder: class { provider = "mock"; } }));
  vi.doMock("../src/ingest/worker", () => ({ IngestWorker: class {
    getTaskProcessor() { return { onTaskCompleted() {} }; }
    enqueue() {}
    async flush() {}
  } }));
  vi.doMock("../src/recall/engine", () => ({ RecallEngine: class {
    search = opts.engineSearch;
    async searchSkills() { return []; }
  } }));
  vi.doMock("../src/ingest/providers", () => ({ Summarizer: class {
    async filterRelevant() { return null; }
  } }));
  vi.doMock("../src/viewer/server", () => ({ ViewerServer: class {
    async start() { return "http://127.0.0.1:18799"; }
    stop() {}
    getResetToken() { return "token"; }
  } }));
  vi.doMock("../src/hub/server", () => ({ HubServer: class {
    async start() { return "http://127.0.0.1:18800"; }
    async stop() {}
  } }));
  vi.doMock("../src/client/hub", () => ({
    hubGetMemoryDetail: async () => ({}),
    hubRequestJson: async () => ({}),
    hubSearchMemories: async () => ({ hits: [], meta: {} }),
    hubSearchSkills: async () => ({ hits: [] }),
    resolveHubClient: async () => ({ hubUrl: "", userToken: "", userId: "" }),
  }));
  vi.doMock("../src/client/connector", () => ({
    connectToHub: async () => ({ connected: false }),
    getHubStatus: async () => ({ connected: false }),
  }));
  vi.doMock("../src/client/skill-sync", () => ({
    fetchHubSkillBundle: async () => ({}),
    publishSkillBundleToHub: async () => ({}),
    restoreSkillBundleFromHub: () => ({}),
    unpublishSkillBundleFromHub: async () => ({}),
  }));
  vi.doMock("../src/skill/evolver", () => ({ SkillEvolver: class { async onTaskCompleted() {} } }));
  vi.doMock("../src/skill/installer", () => ({ SkillInstaller: class {
    getCompanionManifest() { return null; }
    install() { return { message: "ok" }; }
  } }));
  vi.doMock("../src/skill/bundled-memory-guide", () => ({ MEMORY_GUIDE_SKILL_MD: "# mock" }));
  vi.doMock("../src/telemetry", () => ({ Telemetry: class {
    trackToolCalled() {}
    trackAutoRecall() {}
    trackMemoryIngested() {}
    trackSkillInstalled() {}
    trackSkillEvolved() {}
    trackPluginStarted() {}
    trackError() {}
    async shutdown() {}
  } }));

  const pluginModule = await import("../plugin-impl");
  pluginModule.default.register({
    id: "memos-local-openclaw-plugin",
    pluginConfig: {},
    config: { plugins: { entries: { "memos-local-openclaw-plugin": {} } } },
    resolvePath: (p: string) => path.join(tmpDir, p.replace(/^~[\\/]/, "")),
    logger: { info() {}, warn() {} },
    registerTool: () => {},
    registerMemoryCapability: () => {},
    registerService: () => {},
    on: (name: string, handler: AutoRecallHook) => {
      handlers.set(name, handler);
    },
  } as any);

  const hook = handlers.get("before_prompt_build");
  if (!hook) throw new Error("before_prompt_build hook was not registered");
  return hook;
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("auto-recall min query length", () => {
  it("skips auto-recall search when query is shorter than configured threshold", async () => {
    const search = vi.fn(async () => ({ hits: [], meta: {} }));
    const hook = await registerPluginAndGetAutoRecallHook({
      config: { recall: { autoRecallMinQueryLength: 10 } },
      engineSearch: search,
    });

    await hook({ prompt: "继续吧" }, { agentId: "main" });

    expect(search).not.toHaveBeenCalled();
  });

  it("runs auto-recall search when query reaches configured threshold", async () => {
    const search = vi.fn(async () => ({ hits: [], meta: {} }));
    const hook = await registerPluginAndGetAutoRecallHook({
      config: { recall: { autoRecallMinQueryLength: 10 } },
      engineSearch: search,
    });

    await hook({ prompt: "remember deployment rollback preference" }, { agentId: "main" });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: "remember deployment rollback preference",
    }));
  });
});
