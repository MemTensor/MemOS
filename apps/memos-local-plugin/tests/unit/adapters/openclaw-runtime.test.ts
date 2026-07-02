import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome, type ResolvedHome } from "../../../core/config/index.js";
import type {
  HostLogger,
  OpenClawHookHandlerMap,
  OpenClawHookName,
  OpenClawPluginApi,
  ServiceDescriptor,
} from "../../../adapters/openclaw/openclaw-api.js";

interface MockApi extends OpenClawPluginApi {
  services: ServiceDescriptor[];
  hooks: Map<OpenClawHookName, OpenClawHookHandlerMap[OpenClawHookName]>;
  logger: HostLogger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

const tempRoots: string[] = [];
let oldMemosHome: string | undefined;

afterEach(() => {
  if (oldMemosHome === undefined) delete process.env.MEMOS_HOME;
  else process.env.MEMOS_HOME = oldMemosHome;
  vi.doUnmock("../../../core/pipeline/index.js");
  vi.doUnmock("../../../server/http.js");
  vi.doUnmock("../../../core/telemetry/index.js");
  vi.doUnmock("../../../adapters/openclaw/bridge.js");
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
  const hooks = new Map<OpenClawHookName, OpenClawHookHandlerMap[OpenClawHookName]>();
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
    hooks,
    registerTool: vi.fn(),
    registerMemoryCapability: vi.fn(),
    on: vi.fn((hookName: OpenClawHookName, handler) => {
      hooks.set(hookName, handler);
    }),
    registerService: vi.fn((svc: ServiceDescriptor) => {
      services.push(svc);
    }),
  };
}

async function loadPluginWithMocks(
  bootstrapMemoryCoreFull: ReturnType<typeof vi.fn>,
  startHttpServer: ReturnType<typeof vi.fn>,
  createOpenClawBridge?: ReturnType<typeof vi.fn>,
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
  if (createOpenClawBridge) {
    vi.doMock("../../../adapters/openclaw/bridge.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../../adapters/openclaw/bridge.js")
      >("../../../adapters/openclaw/bridge.js");
      return {
        ...actual,
        createOpenClawBridge,
      };
    });
  }
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
  it("blocks a duplicate register before the second runtime bootstraps", async () => {
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
    expect(() => plugin.register(api2)).toThrow(/already active/);
    expect(bootstrapMemoryCoreFull).toHaveBeenCalledTimes(1);
    expect(api2.registerTool).not.toHaveBeenCalled();
    expect(api2.on).not.toHaveBeenCalled();

    boot.resolve({ core: firstCore, config: DEFAULT_CONFIG, home });
    await api1.services[0]!.start?.();
    await api1.services[0]!.stop?.();

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

// ─── Regressions for issue #1815 ────────────────────────────────────────────
//
// OpenClaw's hook runner enforces two contracts memos must respect:
//
//   1. `tool_result_persist` is a value-returning **synchronous** hook.
//      The runner inspects the return value with `isPromiseLike(ret)` and
//      silently ignores anything that looks like a Promise. If memos
//      registers an `async` listener, the hint-injection feature is
//      dead — and OpenClaw logs:
//        "tool_result_persist handler from memos-local-plugin returned a
//         Promise; this hook is synchronous and the result was ignored."
//   2. `agent_end` (and the other void hooks) is gated by a hard-coded
//      `DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK.agent_end = 30_000` budget.
//      A long-running awaited handler trips the gateway log warning:
//        "agent_end handler from memos-local-plugin failed: timed out
//         after 30000ms".
//
// These two regressions cover the listener wrappers in
// `adapters/openclaw/index.ts` — the bridge handlers themselves are
// already correctly shaped and exercised by openclaw-bridge.test.ts.

function buildPluginWithFakeBridge(opts: {
  bridge: Record<string, ReturnType<typeof vi.fn>>;
}): Promise<unknown> {
  const home = useTempMemosHome();
  const core = makeCore();
  const bootstrapMemoryCoreFull = vi.fn(async () => ({
    core,
    config: DEFAULT_CONFIG,
    home,
  }));
  const startHttpServer = vi.fn(async () => ({
    url: "http://127.0.0.1:18799",
    port: 18799,
    closed: false,
    close: vi.fn(async () => {}),
  }));
  const createOpenClawBridge = vi.fn(() => opts.bridge);
  return loadPluginWithMocks(
    bootstrapMemoryCoreFull,
    startHttpServer,
    createOpenClawBridge,
  );
}

function buildBridgeStub() {
  return {
    handleBeforePrompt: vi.fn(async () => undefined),
    handleAgentEnd: vi.fn(async () => undefined),
    handleBeforeToolCall: vi.fn(() => undefined),
    handleAfterToolCall: vi.fn(async () => undefined),
    handleToolResultPersist: vi.fn((_event: unknown) => ({
      message: { content: "hint-applied" },
    })),
    handleSessionStart: vi.fn(async () => undefined),
    handleSessionEnd: vi.fn(async () => undefined),
    handleSubagentSpawned: vi.fn(() => undefined),
    handleSubagentEnded: vi.fn(async () => undefined),
    trackedSessions: vi.fn(() => 0),
    trackedToolCalls: vi.fn(() => 0),
  };
}

describe("OpenClaw hook listener contract (issue #1815)", () => {
  it("registers tool_result_persist as a SYNC listener that returns the bridge result directly (not a Promise)", async () => {
    const bridge = buildBridgeStub();
    const plugin = (await buildPluginWithFakeBridge({ bridge })) as {
      register: (api: OpenClawPluginApi) => void;
    };
    const api = makeApi();
    plugin.register(api);
    await api.services[0]!.start?.();

    const handler = api.hooks.get("tool_result_persist") as
      | OpenClawHookHandlerMap["tool_result_persist"]
      | undefined;
    expect(handler).toBeDefined();

    // Critical contract: the listener must NOT be an async function.
    // OpenClaw checks `handler.constructor.name === "AsyncFunction"` /
    // `isPromiseLike(ret)` to decide whether to ignore the return value
    // — both flag it as broken.
    expect(handler!.constructor.name).not.toBe("AsyncFunction");

    const result = handler!(
      {
        toolName: "sh",
        toolCallId: "call_X",
        message: {
          role: "toolResult",
          content: "boom",
          isError: true,
        },
      },
      {
        toolName: "sh",
        toolCallId: "call_X",
        agentId: "main",
        sessionKey: "s-1",
        sessionId: "host-s-1",
        runId: "run-1",
      },
    );

    // The return value must be the bridge's payload directly, not a
    // Promise that wraps it. OpenClaw's hook runner ignores Promises.
    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { message?: { content?: string } } | void)?.message?.content).toBe(
      "hint-applied",
    );
    expect(bridge.handleToolResultPersist).toHaveBeenCalledTimes(1);

    await api.services[0]!.stop?.();
  });

  it("tool_result_persist listener silently no-ops when bootstrap has not finished yet", async () => {
    const home = useTempMemosHome();
    const core = makeCore();
    const bootDeferred = deferred<{
      core: ReturnType<typeof makeCore>;
      config: typeof DEFAULT_CONFIG;
      home: ResolvedHome;
    }>();
    const bootstrapMemoryCoreFull = vi.fn(() => bootDeferred.promise);
    const startHttpServer = vi.fn(async () => ({
      url: "http://127.0.0.1:18799",
      port: 18799,
      closed: false,
      close: vi.fn(async () => {}),
    }));
    const bridge = buildBridgeStub();
    const createOpenClawBridge = vi.fn(() => bridge);
    const plugin = await loadPluginWithMocks(
      bootstrapMemoryCoreFull,
      startHttpServer,
      createOpenClawBridge,
    );

    const api = makeApi();
    plugin.register(api);

    // Bootstrap is intentionally still pending here — runtime is null.
    const handler = api.hooks.get("tool_result_persist") as
      | OpenClawHookHandlerMap["tool_result_persist"]
      | undefined;
    expect(handler).toBeDefined();

    const result = handler!(
      {
        toolName: "sh",
        toolCallId: "call_X",
        message: { role: "toolResult", content: "boom", isError: true },
      },
      { toolName: "sh", agentId: "main", sessionKey: "s-1", runId: "run-1" },
    );

    // Must be a synchronous undefined return, NOT a Promise. The bridge
    // factory should not even have been invoked yet.
    expect(result).toBeUndefined();
    expect(bridge.handleToolResultPersist).not.toHaveBeenCalled();

    // Finish bootstrap so afterEach can clean up.
    bootDeferred.resolve({ core, config: DEFAULT_CONFIG, home });
    await api.services[0]!.start?.();
    await api.services[0]!.stop?.();
  });

  it("agent_end listener returns synchronously and dispatches the bridge work as fire-and-forget", async () => {
    let releaseAgentEnd: (() => void) | null = null;
    const agentEndStarted = vi.fn();
    const bridge = buildBridgeStub();
    bridge.handleAgentEnd = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          agentEndStarted();
          releaseAgentEnd = resolve;
        }),
    );

    const plugin = (await buildPluginWithFakeBridge({ bridge })) as {
      register: (api: OpenClawPluginApi) => void;
    };
    const api = makeApi();
    plugin.register(api);
    await api.services[0]!.start?.();

    const handler = api.hooks.get("agent_end") as
      | OpenClawHookHandlerMap["agent_end"]
      | undefined;
    expect(handler).toBeDefined();

    const beforeReturn = Date.now();
    const ret = handler!(
      { messages: [], success: true, durationMs: 10 },
      { agentId: "main", sessionKey: "s-1", runId: "run-1" },
    );
    const afterReturn = Date.now();

    // OpenClaw's contract: the listener must return void / undefined,
    // NOT a Promise that the runner would await against the 30 s
    // hard-coded budget.
    expect(ret).toBeUndefined();
    expect(afterReturn - beforeReturn).toBeLessThan(50);

    // The bridge work, however, MUST eventually run — fire-and-forget,
    // not fire-and-drop.
    await vi.waitFor(() => {
      expect(bridge.handleAgentEnd).toHaveBeenCalledTimes(1);
    });
    expect(agentEndStarted).toHaveBeenCalledTimes(1);

    // Release the background work so afterEach can shut down cleanly.
    releaseAgentEnd?.();
    await api.services[0]!.stop?.();
  });

  it("agent_end listener swallows background errors via opts.log.warn instead of surfacing them to OpenClaw", async () => {
    const bridge = buildBridgeStub();
    bridge.handleAgentEnd = vi.fn(async () => {
      throw new Error("boom inside onTurnEnd");
    });

    const plugin = (await buildPluginWithFakeBridge({ bridge })) as {
      register: (api: OpenClawPluginApi) => void;
    };
    const api = makeApi();
    plugin.register(api);
    await api.services[0]!.start?.();

    const handler = api.hooks.get("agent_end") as
      | OpenClawHookHandlerMap["agent_end"]
      | undefined;
    expect(handler).toBeDefined();
    expect(() =>
      handler!(
        { messages: [], success: true },
        { agentId: "main", sessionKey: "s-1", runId: "run-1" },
      ),
    ).not.toThrow();

    await vi.waitFor(() => {
      expect(api.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("hook agent_end failed"),
        expect.objectContaining({ err: expect.stringContaining("boom inside onTurnEnd") }),
      );
    });

    await api.services[0]!.stop?.();
  });

  it("every void hook listener (agent_end / session_* / *_tool_call / subagent_*) is registered as a non-async function", async () => {
    const bridge = buildBridgeStub();
    const plugin = (await buildPluginWithFakeBridge({ bridge })) as {
      register: (api: OpenClawPluginApi) => void;
    };
    const api = makeApi();
    plugin.register(api);
    await api.services[0]!.start?.();

    // before_prompt_build is value-returning and the only listener
    // allowed to be async (OpenClaw awaits its prependContext).
    const voidHooks: OpenClawHookName[] = [
      "agent_end",
      "before_tool_call",
      "after_tool_call",
      "tool_result_persist",
      "session_start",
      "session_end",
      "subagent_spawned",
      "subagent_ended",
    ];
    for (const name of voidHooks) {
      const handler = api.hooks.get(name);
      expect(handler, `${name} listener missing`).toBeDefined();
      expect(
        handler!.constructor.name,
        `${name} listener must not be async; OpenClaw runs it on a sync/void path`,
      ).not.toBe("AsyncFunction");
    }

    await api.services[0]!.stop?.();
  });
});
