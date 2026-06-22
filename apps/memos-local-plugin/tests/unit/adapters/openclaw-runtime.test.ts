import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome, type ResolvedHome } from "../../../core/config/index.js";
import type {
  HostLogger,
  OpenClawHookHandlerMap,
  OpenClawPluginApi,
  ServiceDescriptor,
} from "../../../adapters/openclaw/openclaw-api.js";

interface MockApi extends OpenClawPluginApi {
  services: ServiceDescriptor[];
  logger: HostLogger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

const tempRoots: string[] = [];
let oldMemosHome: string | undefined;

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__memos_local_openclaw_runtime_v1__;
  if (oldMemosHome === undefined) delete process.env.MEMOS_HOME;
  else process.env.MEMOS_HOME = oldMemosHome;
  vi.doUnmock("../../../core/pipeline/index.js");
  vi.doUnmock("../../../server/http.js");
  vi.doUnmock("../../../core/telemetry/index.js");
  vi.resetModules();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function useTempMemosHome(): ResolvedHome {
  oldMemosHome = process.env.MEMOS_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memos-oc-runtime-"));
  tempRoots.push(root);
  process.env.MEMOS_HOME = root;
  return resolveHome("openclaw");
}

function makeCore() {
  return {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    bindTelemetry: vi.fn(),
  };
}

function makeApi(): MockApi {
  const services: ServiceDescriptor[] = [];
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    id: "memos-local-plugin",
    name: "MemOS Local",
    logger,
    services,
    registerTool: vi.fn(),
    registerMemoryCapability: vi.fn(),
    on: vi.fn(),
    registerService: vi.fn((svc: ServiceDescriptor) => {
      services.push(svc);
    }),
  };
}

async function loadPluginWithMocks(
  bootstrapMemoryCoreFull: ReturnType<typeof vi.fn>,
  startHttpServer: ReturnType<typeof vi.fn>,
) {
  vi.resetModules();
  vi.doMock("../../../core/pipeline/index.js", () => ({
    bootstrapMemoryCoreFull,
  }));
  vi.doMock("../../../server/http.js", () => ({
    startHttpServer,
  }));
  vi.doMock("../../../core/telemetry/index.js", () => ({
    Telemetry: class {
      trackPluginStarted = vi.fn();
      shutdown = vi.fn(async () => {});
    },
  }));
  const mod = await import("../../../adapters/openclaw/index.js");
  return mod.default;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("OpenClaw adapter runtime lifecycle", () => {
  it("registers hot-path hooks without returning promises while runtime boots", async () => {
    const home = useTempMemosHome();
    const core = makeCore();
    const boot = deferred<{ core: ReturnType<typeof makeCore>; config: typeof DEFAULT_CONFIG; home: ResolvedHome }>();
    const bootstrapMemoryCoreFull = vi.fn(() => boot.promise);
    const startHttpServer = vi.fn(async () => ({
      url: "http://127.0.0.1:18799",
      port: 18799,
      closed: false,
      close: vi.fn(async () => {}),
    }));
    const plugin = await loadPluginWithMocks(bootstrapMemoryCoreFull, startHttpServer);

    const api = makeApi();
    plugin.register(api);

    const hookCall = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      ([name]) => name === "tool_result_persist",
    );
    expect(hookCall).toBeDefined();
    const handler = hookCall![1] as OpenClawHookHandlerMap["tool_result_persist"];
    const beforeCompactionCall = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      ([name]) => name === "before_compaction",
    );
    expect(beforeCompactionCall).toBeDefined();
    const beforeCompaction =
      beforeCompactionCall![1] as OpenClawHookHandlerMap["before_compaction"];
    try {
      const result = handler(
        {
          toolName: "sh",
          toolCallId: "call-sync",
          message: {
            role: "toolResult",
            toolName: "sh",
            toolCallId: "call-sync",
            content: "boom",
            isError: true,
          },
        },
        {
          agentId: "main",
          sessionKey: "s-sync-hook",
          sessionId: "host-sync-hook",
          runId: "run-sync-hook",
          toolName: "sh",
          toolCallId: "call-sync",
        },
      );
      expect(result).toBeUndefined();
      const compactionResult = beforeCompaction(
        {
          messageCount: 1,
          compactingCount: 1,
          messages: [{ role: "user", content: "before compact" }],
        },
        {
          agentId: "main",
          sessionKey: "s-sync-hook",
          sessionId: "host-sync-hook",
          runId: "run-sync-hook",
        },
      );
      expect(compactionResult).toBeUndefined();
    } finally {
      boot.resolve({ core, config: DEFAULT_CONFIG, home });
      await api.services[0]!.start?.();
      await api.services[0]!.stop?.();
    }
  });

  it("reuses the in-process runtime across repeated register() calls", async () => {
    const home = useTempMemosHome();
    const firstCore = makeCore();
    const boot = deferred<{ core: ReturnType<typeof makeCore>; config: typeof DEFAULT_CONFIG; home: ResolvedHome }>();
    const bootstrapMemoryCoreFull = vi.fn(() => boot.promise);
    const startHttpServer = vi.fn(async () => ({
      url: "http://127.0.0.1:18799",
      port: 18799,
      closed: false,
      close: vi.fn(async () => {}),
    }));
    const plugin = await loadPluginWithMocks(bootstrapMemoryCoreFull, startHttpServer);

    const api1 = makeApi();
    plugin.register(api1);
    expect(bootstrapMemoryCoreFull).toHaveBeenCalledTimes(1);

    const api2 = makeApi();
    expect(() => plugin.register(api2)).not.toThrow();
    expect(bootstrapMemoryCoreFull).toHaveBeenCalledTimes(1);
    expect(api2.registerTool).toHaveBeenCalled();
    expect(api2.on).toHaveBeenCalled();

    boot.resolve({ core: firstCore, config: DEFAULT_CONFIG, home });
    await api1.services[0]!.start?.();
    await api2.services[0]!.start?.();
    await api1.services[0]!.stop?.();
    expect(fs.existsSync(path.join(home.daemonDir, "openclaw-runtime.lock"))).toBe(true);
    await api2.services[0]!.stop?.();

    expect(fs.existsSync(path.join(home.daemonDir, "openclaw-runtime.lock"))).toBe(false);
  });

  it("treats viewer EADDRINUSE as fatal and releases core plus lock", async () => {
    const home = useTempMemosHome();
    const core = makeCore();
    const bootstrapMemoryCoreFull = vi.fn(async () => ({
      core,
      config: DEFAULT_CONFIG,
      home,
    }));
    const inUse = Object.assign(new Error("address already in use"), {
      code: "EADDRINUSE",
    });
    const startHttpServer = vi.fn(async () => {
      throw inUse;
    });
    const plugin = await loadPluginWithMocks(bootstrapMemoryCoreFull, startHttpServer);

    const api = makeApi();
    plugin.register(api);

    await expect(api.services[0]!.start?.()).rejects.toMatchObject({
      code: "EADDRINUSE",
    });

    expect(core.init).toHaveBeenCalledTimes(1);
    expect(core.shutdown).toHaveBeenCalledTimes(1);
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("refusing duplicate/headless OpenClaw runtime"),
    );
    expect(api.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("running headless"),
    );
    expect(fs.existsSync(path.join(home.daemonDir, "openclaw-runtime.lock"))).toBe(false);
  });
});
