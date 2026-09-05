import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import type { Config } from "../../../adapters/deepseek-harness/index.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import type {
  ResolvedConfig,
  ResolvedHome,
} from "../../../core/config/index.js";

const pluginRoot = resolve(import.meta.dirname, "../../..");
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const mockedModules = [
  "../../../adapters/deepseek-harness/bridge.js",
  "../../../core/config/index.js",
  "../../../core/index.js",
  "../../../server/http.js",
  "../../../server/index.js",
] as const;

afterEach(() => {
  vi.useRealTimers();
  for (const moduleId of mockedModules) vi.doUnmock(moduleId);
  vi.resetModules();
  vi.restoreAllMocks();
});

function adapterConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    profileId: "web",
    home: "",
    recallEnabled: true,
    captureEnabled: true,
    toolsEnabled: false,
    hostLlmEnabled: false,
    recallTimeoutMs: 12_000,
    contextMaxChars: 6_000,
    toolResultMaxChars: 1_200,
    // The public Cordis row can disable only the optional UI while retaining
    // the memory lifecycle.
    viewerEnabled: true,
    viewerPort: 18_801,
    failOnStartupError: false,
    ...overrides,
  };
}

function resolvedHome(): ResolvedHome {
  const root = "/tmp/memos-dsh-viewer-test";
  return {
    root,
    configFile: resolve(root, "config.yaml"),
    dataDir: resolve(root, "data"),
    dbFile: resolve(root, "data/memos.db"),
    skillsDir: resolve(root, "skills"),
    logsDir: resolve(root, "logs"),
    daemonDir: resolve(root, "daemon"),
  };
}

function memoryConfig(bindHost = "127.0.0.42"): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    viewer: {
      ...DEFAULT_CONFIG.viewer,
      // Deliberately retain a stale shared port. DSH owns :18801 and must
      // only inherit the bind host from config.yaml.
      port: 18_799,
      bindHost,
    },
  };
}

function makeContext() {
  const activeRegistrations = new Set<symbol>();
  const register = () => {
    const token = Symbol("registration");
    activeRegistrations.add(token);
    return vi.fn(() => activeRegistrations.delete(token));
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    activeRegistrations,
    logger,
    context: {
      logger,
      llm: {},
      systemPrompt: { section: vi.fn(register) },
      on: vi.fn(register),
      tools: { register: vi.fn(register) },
    },
  };
}

async function loadAdapter(options: {
  startViewer?: () => Promise<unknown>;
  bindHost?: string;
  lifecycle?: string[];
} = {}) {
  const lifecycle = options.lifecycle ?? [];
  const home = resolvedHome();
  const config = memoryConfig(options.bindHost);
  const core = {
    init: vi.fn(async () => {
      lifecycle.push("core.init");
    }),
    shutdown: vi.fn(async () => {
      lifecycle.push("core.shutdown");
    }),
  } as unknown as MemoryCore;
  const bridge = {
    beforeStep: vi.fn(),
    onSessionEvent: vi.fn(),
    flush: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => undefined),
    currentEpisode: vi.fn(),
    dispose: vi.fn(async () => {
      lifecycle.push("bridge.dispose");
      await core.shutdown();
    }),
  };
  const viewer = {
    url: "http://127.0.0.42:18801",
    port: 18_801,
    closed: false,
    close: vi.fn(async () => {
      lifecycle.push("viewer.close");
    }),
  };
  const startHttpServer = vi.fn(
    options.startViewer
      ? options.startViewer
      : async () => viewer,
  );
  const bootstrapMemoryCore = vi.fn(async () => core);
  const resolveHome = vi.fn(() => home);
  const loadConfig = vi.fn(async () => ({ config, warnings: [] }));
  const createDeepSeekHarnessBridge = vi.fn(() => bridge);

  vi.resetModules();
  vi.doMock("../../../core/config/index.js", async () => {
    const actual = await vi.importActual<
      typeof import("../../../core/config/index.js")
    >("../../../core/config/index.js");
    return { ...actual, resolveHome, loadConfig };
  });
  vi.doMock("../../../core/index.js", () => ({ bootstrapMemoryCore }));
  vi.doMock("../../../server/http.js", () => ({ startHttpServer }));
  vi.doMock("../../../server/index.js", () => ({ startHttpServer }));
  vi.doMock("../../../adapters/deepseek-harness/bridge.js", async () => {
    const actual = await vi.importActual<
      typeof import("../../../adapters/deepseek-harness/bridge.js")
    >("../../../adapters/deepseek-harness/bridge.js");
    return { ...actual, createDeepSeekHarnessBridge };
  });

  const adapter = await import("../../../adapters/deepseek-harness/index.js");
  return {
    ...adapter,
    bootstrapMemoryCore,
    bridge,
    config,
    core,
    createDeepSeekHarnessBridge,
    home,
    lifecycle,
    loadConfig,
    startHttpServer,
    viewer,
  };
}

function addressInUse(): NodeJS.ErrnoException {
  return Object.assign(new Error("address already in use"), {
    code: "EADDRINUSE",
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlesBeforeRealDeadline(
  promise: Promise<unknown>,
  timeoutMs = 100,
): Promise<"settled" | "timeout"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => "settled" as const),
      new Promise<"timeout">((resolveTimeout) => {
        timeout = realSetTimeout(() => resolveTimeout("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) realClearTimeout(timeout);
  }
}

describe("DeepSeek Harness Viewer lifecycle", () => {
  it("publishes safe Cordis defaults for the DSH Viewer", async () => {
    const runtime = await loadAdapter();

    expect(runtime.DEEPSEEK_HARNESS_VIEWER_PORT).toBe(18_801);
    expect(runtime.deepSeekHarnessSearchTimeoutMs(12_000)).toBe(3_000);
    expect(runtime.Config({})).toMatchObject({
      viewerEnabled: true,
      viewerPort: 18_801,
      recallTimeoutMs: 3_000,
      failOnStartupError: false,
    });
    expect(() => runtime.Config({ viewerPort: 0 })).toThrow();
    expect(() => runtime.Config({ viewerPort: 65_536 })).toThrow();
    expect(() => runtime.Config({ viewerPort: 18_801.5 })).toThrow();
    expect(runtime.isDeepSeekHarnessViewerLoopbackHost("127.0.0.1")).toBe(true);
    expect(runtime.isDeepSeekHarnessViewerLoopbackHost("localhost")).toBe(true);
    expect(runtime.isDeepSeekHarnessViewerLoopbackHost("0.0.0.0")).toBe(false);
    expect(runtime.isDeepSeekHarnessViewerLoopbackHost("192.168.1.20")).toBe(false);
  });

  it("resolves Viewer assets deterministically in source and packed layouts", async () => {
    const runtime = await loadAdapter();
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "memos-dsh-viewer-layout-"));
    // A package root may itself be named `dist`; package.json is the stable
    // layout marker. Deliberately leave viewer/dist unbuilt, as in clean CI.
    const packageRoot = resolve(fixtureRoot, "dist");
    mkdirSync(resolve(packageRoot, "adapters/deepseek-harness"), {
      recursive: true,
    });
    mkdirSync(resolve(packageRoot, "dist/adapters/deepseek-harness"), {
      recursive: true,
    });
    writeFileSync(resolve(packageRoot, "package.json"), "{}\n", "utf8");

    try {
      expect(
        runtime.resolveDeepSeekHarnessViewerStaticRoot(
          resolve(packageRoot, "adapters/deepseek-harness"),
        ),
      ).toBe(resolve(packageRoot, "viewer/dist"));
      expect(
        runtime.resolveDeepSeekHarnessViewerStaticRoot(
          resolve(packageRoot, "dist/adapters/deepseek-harness"),
        ),
      ).toBe(resolve(packageRoot, "viewer/dist"));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("starts the bundled Viewer on the DSH-owned loopback endpoint", async () => {
    const lifecycle: string[] = [];
    const runtime = await loadAdapter({ lifecycle });
    const host = makeContext();

    const dispose = await runtime.apply(
      host.context as never,
      adapterConfig(),
    );

    expect(runtime.startHttpServer).toHaveBeenCalledTimes(1);
    expect(runtime.startHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        core: runtime.core,
        home: runtime.home,
      }),
      expect.objectContaining({
        port: 18_801,
        host: "127.0.0.42",
        staticRoot: resolve(pluginRoot, "viewer/dist"),
        agent: "deepseek-harness",
        closeActiveSseOnShutdown: true,
      }),
    );
    expect(host.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(runtime.viewer.url),
    );
    const registeredEvents = host.context.on.mock.calls.map(([event]) => event);
    expect(registeredEvents).toContain("session/disposed");
    expect(registeredEvents).not.toContain("session/flush");

    await dispose();

    expect(lifecycle).toEqual([
      "core.init",
      "viewer.close",
      "bridge.dispose",
      "core.shutdown",
    ]);
    expect(host.activeRegistrations.size).toBe(0);
  });

  it("detaches session disposal from unfinished memory lifecycle work", async () => {
    const runtime = await loadAdapter();
    const host = makeContext();
    const close = deferred<void>();
    runtime.bridge.closeSession.mockImplementation(async () => close.promise);

    const dispose = await runtime.apply(
      host.context as never,
      adapterConfig({ viewerEnabled: false }),
    );
    const disposedRegistration = host.context.on.mock.calls.find(
      ([event]) => event === "session/disposed",
    );
    const handler = disposedRegistration?.[1] as
      | ((session: { id: string }) => unknown)
      | undefined;

    expect(handler).toBeTypeOf("function");
    expect(handler?.({ id: "detached-session" })).toBeUndefined();
    expect(runtime.bridge.closeSession).toHaveBeenCalledWith({
      id: "detached-session",
    });

    close.resolve();
    await close.promise;

    runtime.bridge.closeSession.mockRejectedValueOnce(new Error("cleanup failed"));
    expect(handler?.({ id: "failed-session" })).toBeUndefined();
    await vi.waitFor(() => {
      expect(host.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("detached session cleanup failed"),
      );
    });
    await dispose();
  });

  it("continues with memory but no Viewer when :18801 is busy and startup is fail-open", async () => {
    const inUse = addressInUse();
    const runtime = await loadAdapter({
      startViewer: async () => {
        throw inUse;
      },
    });
    const host = makeContext();

    const dispose = await runtime.apply(
      host.context as never,
      adapterConfig({ failOnStartupError: false }),
    );

    expect(runtime.startHttpServer).toHaveBeenCalledTimes(1);
    expect(runtime.createDeepSeekHarnessBridge).toHaveBeenCalledTimes(1);
    expect(runtime.core.shutdown).not.toHaveBeenCalled();
    expect(host.activeRegistrations.size).toBeGreaterThan(0);
    expect(host.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/viewer.*18801|18801.*viewer/i),
    );

    await dispose();
    expect(runtime.bridge.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.core.shutdown).toHaveBeenCalledTimes(1);
    expect(host.activeRegistrations.size).toBe(0);
  });

  it("recovers the Viewer in the background after a transient port collision", async () => {
    vi.useFakeTimers();
    const inUse = addressInUse();
    const recoveredClose = vi.fn(async () => undefined);
    let attempt = 0;
    const runtime = await loadAdapter({
      startViewer: async () => {
        attempt += 1;
        if (attempt === 1) throw inUse;
        return {
          url: "http://127.0.0.42:18801",
          port: 18_801,
          closed: false,
          close: recoveredClose,
        };
      },
    });
    const host = makeContext();

    const dispose = await runtime.apply(
      host.context as never,
      adapterConfig({ failOnStartupError: false }),
    );

    expect(runtime.startHttpServer).toHaveBeenCalledTimes(1);
    expect(host.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("retries in the background"),
    );

    await vi.advanceTimersByTimeAsync(
      runtime.DEEPSEEK_HARNESS_VIEWER_RETRY_DELAYS_MS[0],
    );

    expect(runtime.startHttpServer).toHaveBeenCalledTimes(2);
    expect(host.logger.info).toHaveBeenCalledWith(
      "memos-local-memory: viewer recovered at http://127.0.0.42:18801",
    );
    expect(recoveredClose).not.toHaveBeenCalled();

    await dispose();
    expect(recoveredClose).toHaveBeenCalledTimes(1);
    expect(runtime.bridge.dispose).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after the bounded EADDRINUSE schedule is exhausted", async () => {
    vi.useFakeTimers();
    const inUse = addressInUse();
    const runtime = await loadAdapter({
      startViewer: async () => {
        throw inUse;
      },
    });
    const host = makeContext();

    const dispose = await runtime.apply(
      host.context as never,
      adapterConfig({ failOnStartupError: false }),
    );

    for (const delayMs of runtime.DEEPSEEK_HARNESS_VIEWER_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delayMs);
    }

    const expectedAttempts = 1 +
      runtime.DEEPSEEK_HARNESS_VIEWER_RETRY_DELAYS_MS.length;
    expect(runtime.startHttpServer).toHaveBeenCalledTimes(expectedAttempts);
    expect(host.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("remained busy after 5 retries"),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.startHttpServer).toHaveBeenCalledTimes(expectedAttempts);

    await dispose();
    expect(runtime.bridge.dispose).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending Viewer retry during Cordis disposal and never binds again", async () => {
    vi.useFakeTimers();
    const inUse = addressInUse();
    const runtime = await loadAdapter({
      startViewer: async () => {
        throw inUse;
      },
    });
    const host = makeContext();

    const dispose = await runtime.apply(
      host.context as never,
      adapterConfig({ failOnStartupError: false }),
    );

    expect(runtime.startHttpServer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.startHttpServer).toHaveBeenCalledTimes(1);
    expect(runtime.bridge.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.core.shutdown).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(runtime.startHttpServer).toHaveBeenCalledTimes(1);
  });

  it("does not block disposal on an in-flight bind and closes its late Viewer", async () => {
    vi.useFakeTimers();
    const inUse = addressInUse();
    const lateBind = deferred<{
      url: string;
      port: number;
      closed: boolean;
      close: () => Promise<void>;
    }>();
    const lateViewerClosed = deferred<void>();
    const lateClose = vi.fn(async () => {
      lateViewerClosed.resolve();
    });
    const lateViewer = {
      url: "http://127.0.0.42:18801",
      port: 18_801,
      closed: false,
      close: lateClose,
    };
    let attempt = 0;
    const runtime = await loadAdapter({
      startViewer: async () => {
        attempt += 1;
        if (attempt === 1) throw inUse;
        return lateBind.promise;
      },
    });
    const host = makeContext();

    const dispose = await runtime.apply(
      host.context as never,
      adapterConfig({ failOnStartupError: false }),
    );
    await vi.advanceTimersByTimeAsync(
      runtime.DEEPSEEK_HARNESS_VIEWER_RETRY_DELAYS_MS[0],
    );
    expect(runtime.startHttpServer).toHaveBeenCalledTimes(2);

    const disposePromise = dispose();
    const disposeOutcome = await settlesBeforeRealDeadline(disposePromise);
    const registrationsAfterDispose = host.activeRegistrations.size;

    // Resolve the uncancellable bind only after observing whether Cordis
    // disposal completed independently from it. This also lets a regressed
    // implementation finish cleanup instead of leaving the test hanging.
    lateBind.resolve(lateViewer);
    const lateCloseOutcome = await settlesBeforeRealDeadline(
      lateViewerClosed.promise,
    );
    await disposePromise;

    expect(disposeOutcome).toBe("settled");
    expect(registrationsAfterDispose).toBe(0);
    expect(lateCloseOutcome).toBe("settled");
    expect(lateClose).toHaveBeenCalledTimes(1);
    expect(runtime.bridge.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.core.shutdown).toHaveBeenCalledTimes(1);
    expect(host.activeRegistrations.size).toBe(0);
  });

  it("refuses a non-loopback Viewer bind without disabling memory", async () => {
    const runtime = await loadAdapter({ bindHost: "0.0.0.0" });
    const host = makeContext();

    const dispose = await runtime.apply(
      host.context as never,
      adapterConfig({ failOnStartupError: false }),
    );

    expect(runtime.startHttpServer).not.toHaveBeenCalled();
    expect(runtime.createDeepSeekHarnessBridge).toHaveBeenCalledTimes(1);
    expect(host.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("must be loopback"),
    );

    await dispose();
    expect(runtime.bridge.dispose).toHaveBeenCalledTimes(1);
  });

  it("rolls back memory and rejects DSH startup when :18801 is busy in fail-fast mode", async () => {
    const inUse = addressInUse();
    const runtime = await loadAdapter({
      startViewer: async () => {
        throw inUse;
      },
    });
    const host = makeContext();

    await expect(runtime.apply(
      host.context as never,
      adapterConfig({ failOnStartupError: true }),
    )).rejects.toBe(inUse);

    expect(runtime.startHttpServer).toHaveBeenCalledTimes(1);
    expect(runtime.core.shutdown).toHaveBeenCalledTimes(1);
    expect(host.activeRegistrations.size).toBe(0);
    expect(host.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("startup failed"),
    );
  });
});
