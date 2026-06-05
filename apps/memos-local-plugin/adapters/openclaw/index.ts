/**
 * OpenClaw plugin entry point — Reflect2Evolve core.
 *
 * Minimal responsibilities (V7 §0.2 + §2.6):
 *   1. Bootstrap `MemoryCore` (storage, migrations, providers, pipeline)
 *      against the resolved home (`~/.openclaw/memos-plugin/` by default).
 *   2. Register the memory capability (prompt prelude).
 *   3. Register memory tools (factory form with trusted plugin context).
 *   4. Wire every algorithm-relevant hook through the bridge:
 *        • `before_prompt_build` → `onTurnStart` (Tier 1+2+3 retrieval)
 *        • `agent_end`           → `onTurnEnd`   (capture + reward chain)
 *        • `before_tool_call`    → duration tracker
 *        • `after_tool_call`     → `recordToolOutcome` (decision-repair)
 *        • `tool_result_persist` → repeated-failure memos_search hint
 *        • `session_start` / `session_end` → core session lifecycle
 *   5. Register a service so the host can flush + shut down cleanly.
 *
 * The plugin owns *no* business logic — everything lives in `core/*`.
 *
 * Host-compatibility contract:
 *   - Tested against OpenClaw SDK `api` shape from
 *     `openclaw/src/plugins/types.ts::OpenClawPluginApi` and hook map from
 *     `openclaw/src/plugins/hook-types.ts::PluginHookHandlerMap`.
 *   - We import **types only** from `./openclaw-api.ts`; the real SDK is
 *     injected by the host at load time.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenClawBridge, type BridgeHandle } from "./bridge.js";
import {
  acquireOpenClawRuntimeLock,
  DuplicateOpenClawRuntimeError,
  type OpenClawRuntimeLockHandle,
} from "./runtime-lock.js";
import { registerOpenClawTools } from "./tools.js";
import type {
  DefinedPluginEntry,
  DefinePluginEntryOptions,
  OpenClawPluginApi,
} from "./openclaw-api.js";

import { bootstrapMemoryCoreFull } from "../../core/pipeline/index.js";
import { resolveHome } from "../../core/config/index.js";
import { rootLogger, memoryBuffer } from "../../core/logger/index.js";
import type { MemoryCore } from "../../agent-contract/memory-core.js";
import { startHttpServer } from "../../server/http.js";
import type { ServerHandle } from "../../server/types.js";
import { Telemetry } from "../../core/telemetry/index.js";

// ─── Plugin metadata ───────────────────────────────────────────────────────

export const PLUGIN_ID = "memos-local-plugin";
export const PLUGIN_VERSION = readPluginPackageVersion();

function readPluginPackageVersion(): string {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const adapterDir = path.dirname(thisFile); // .../adapters/openclaw or .../dist/adapters/openclaw
    const candidates = [
      path.resolve(adapterDir, "..", "..", "..", "package.json"),
      path.resolve(adapterDir, "..", "..", "package.json"),
    ];
    const packageJsonPath = candidates.find((candidate) => existsSync(candidate));
    if (!packageJsonPath) return "dev";
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" && pkg.version.trim()
      ? pkg.version
      : "dev";
  } catch {
    return "dev";
  }
}

// ─── Runtime state (per plugin load) ───────────────────────────────────────

interface PluginRuntime {
  core: MemoryCore;
  bridge: BridgeHandle;
  /**
   * The viewer HTTP server. OpenClaw must own this port; if binding
   * fails we abort bootstrap instead of running a second headless
   * runtime that would still register hooks and write memory.
   */
  viewer: ServerHandle | null;
  shutdown: () => Promise<void>;
}

interface SharedRuntimeState {
  registrations: number;
  runtime: PluginRuntime | null;
  bootstrapError: Error | null;
  bootstrapPromise: Promise<void>;
}

const SHARED_RUNTIME_KEY = "__memos_local_openclaw_runtime_v1__";

function readSharedRuntimeState(): SharedRuntimeState | null {
  const g = globalThis as Record<string, unknown>;
  const state = g[SHARED_RUNTIME_KEY];
  if (!state || typeof state !== "object") return null;
  return state as SharedRuntimeState;
}

function writeSharedRuntimeState(state: SharedRuntimeState | null): void {
  const g = globalThis as Record<string, unknown>;
  if (state) g[SHARED_RUNTIME_KEY] = state;
  else delete g[SHARED_RUNTIME_KEY];
}

/**
 * Locate the plugin source root (the directory holding `package.json`,
 * `bridge.cts`, etc.). Two layouts to support: built tarball
 * (`<plugin>/dist/adapters/openclaw`) and source/tests
 * (`<plugin>/adapters/openclaw`). Returned path is the one used by
 * `Telemetry` to find `telemetry.credentials.json` (CI writes it
 * here pre-publish via `scripts/generate-telemetry-credentials.cjs`).
 */
function resolvePluginRoot(): string | undefined {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const adapterDir = path.dirname(thisFile); // .../adapters/openclaw
    const candidates = [
      path.resolve(adapterDir, "..", "..", ".."),
      path.resolve(adapterDir, "..", ".."),
    ];
    return candidates.find((candidate) =>
      existsSync(path.join(candidate, "package.json")),
    );
  } catch {
    return undefined;
  }
}

/** Locate the bundled viewer static assets relative to the plugin root. */
function resolveViewerStaticRoot(): string | undefined {
  // Built packages load from `<plugin>/dist/adapters`; source tests load
  // from `<plugin>/adapters`. The viewer bundle remains at `viewer/dist`.
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const adapterDir = path.dirname(thisFile); // .../adapters/openclaw
    const candidates = [
      path.resolve(adapterDir, "..", "..", "..", "viewer", "dist"),
      path.resolve(adapterDir, "..", "..", "viewer", "dist"),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  } catch {
    return undefined;
  }
}

const OPENCLAW_VIEWER_PORT = 18799;

function memoryAddDisabledFromConfig(config: Record<string, unknown> | undefined): boolean {
  const memoryAdd = config?.memory_add;
  if (!memoryAdd || typeof memoryAdd !== "object" || Array.isArray(memoryAdd)) {
    return false;
  }
  return (memoryAdd as { enabled?: unknown }).enabled === false;
}

async function createRuntime(
  api: OpenClawPluginApi,
  runtimeLock: OpenClawRuntimeLockHandle,
): Promise<PluginRuntime> {
  const log = rootLogger.child({ channel: "adapters.openclaw" });
  log.info("plugin.bootstrap", { version: PLUGIN_VERSION });

  let core: MemoryCore | null = null;
  let viewer: ServerHandle | null = null;

  try {
    // Bootstrap core — returns `{ core, home, config }` so we know which
    // viewer port to bind.
    const boot = await bootstrapMemoryCoreFull({
      agent: "openclaw",
      namespace: { agentKind: "openclaw", profileId: "main" },
      pkgVersion: PLUGIN_VERSION,
    });
    core = boot.core;
    const { config, home } = boot;
    await core.init();

    // Anonymous ARMS telemetry. Mirrors `bridge.cts`'s setup so OpenClaw
    // emits the same `plugin_started` / `daily_active` / `memos_search`
    // / `memory_ingested` / `feedback_submitted` / `viewer_opened`
    // events under the same `memos_local_hermes_v2` group as Hermes.
    // Without this every OpenClaw user was invisible in ARMS — only the
    // hermes-side `bridge.cts` was emitting events.
    //
    // Order matters:
    //   1. `new Telemetry` reads `config.telemetry` and the credentials
    //      file under the plugin source root.
    //   2. `bindTelemetry` must run before any turn so that
    //      `memory-core.ts`'s `if (telemetry)` guards see a non-null
    //      instance on the very first `onTurnStart`.
    //   3. `trackPluginStarted` immediately after also fires
    //      `daily_active` (with persistent dedup; see sender.ts).
    // `core.shutdown()` flushes telemetry as part of its `finally`
    // block, so we don't need to await `telemetry.shutdown()` here.
    const telemetry = new Telemetry(
      config.telemetry ?? {},
      home.root,
      PLUGIN_VERSION,
      rootLogger.child({ channel: "core.telemetry" }),
      resolvePluginRoot(),
    );
    (
      core as { bindTelemetry?: (t: InstanceType<typeof Telemetry>) => void }
    ).bindTelemetry?.(telemetry);
    telemetry.trackPluginStarted("openclaw");

    const bridge = createOpenClawBridge({
      agent: "openclaw",
      core,
      log: api.logger,
      memoryAddDisabled: memoryAddDisabledFromConfig(api.pluginConfig),
    });

    // OpenClaw's viewer port is fixed at :18799 (hermes uses :18800).
    // We ignore `config.viewer.port` for the same reason `bridge.cts`
    // does: old config.yaml files baked in the legacy single-port
    // :18799 used by both agents, and we don't want hermes to collide
    // with us because of stale YAML.
    try {
      viewer = await startHttpServer(
        {
          core,
          home,
          logTail: () => memoryBuffer().tail({ limit: 200 }),
          telemetry,
        },
        {
          port: OPENCLAW_VIEWER_PORT,
          host: config.viewer.bindHost,
          staticRoot: resolveViewerStaticRoot(),
          agent: "openclaw",
        },
      );
      api.logger.info(`memos-local: viewer live at ${viewer.url}`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "EADDRINUSE") {
        api.logger.error(
          `memos-local: viewer port :${OPENCLAW_VIEWER_PORT} is already in use — ` +
            `refusing duplicate/headless OpenClaw runtime.`,
        );
      } else {
        api.logger.error("memos-local: viewer failed to start", {
          err: e?.message ?? String(err),
        });
      }
      throw err;
    }

    const runtimeCore = core;
    const runtimeViewer = viewer;
    return {
      core: runtimeCore,
      bridge,
      viewer: runtimeViewer,
      async shutdown() {
        if (runtimeViewer) {
          try {
            await runtimeViewer.close();
          } catch (err) {
            api.logger.warn("memos-local: viewer close error", {
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        try {
          await runtimeCore.shutdown();
        } catch (err) {
          api.logger.warn("memos-local: shutdown error", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        runtimeLock.release();
      },
    };
  } catch (err) {
    await closeViewerAfterFailedBootstrap(viewer);
    if (core) {
      try {
        await core.shutdown();
      } catch {
        /* best-effort cleanup after failed bootstrap */
      }
    }
    runtimeLock.release();
    throw err;
  }
}

async function closeViewerAfterFailedBootstrap(
  viewer: ServerHandle | null,
): Promise<void> {
  if (!viewer) return;
  try {
    await viewer.close();
  } catch {
    /* best-effort cleanup after failed bootstrap */
  }
}

function createSharedRuntimeState(api: OpenClawPluginApi): SharedRuntimeState {
  let runtimeLock: OpenClawRuntimeLockHandle;
  try {
    runtimeLock = acquireOpenClawRuntimeLock({
      home: resolveHome("openclaw"),
      pluginId: PLUGIN_ID,
      version: PLUGIN_VERSION,
      viewerPort: OPENCLAW_VIEWER_PORT,
    });
  } catch (err) {
    const duplicate = err instanceof DuplicateOpenClawRuntimeError;
    api.logger.error("memos-local: duplicate OpenClaw runtime blocked", {
      err: err instanceof Error ? err.message : String(err),
      code: duplicate ? err.code : (err as { code?: unknown }).code,
    });
    throw err;
  }

  const state: SharedRuntimeState = {
    registrations: 0,
    runtime: null,
    bootstrapError: null,
    bootstrapPromise: Promise.resolve(),
  };
  state.bootstrapPromise = createRuntime(api, runtimeLock)
    .then((runtime) => {
      state.runtime = runtime;
      api.logger.info("memos-local: plugin ready");
    })
    .catch((err) => {
      state.bootstrapError = err instanceof Error ? err : new Error(String(err));
      const duplicate = err instanceof DuplicateOpenClawRuntimeError;
      api.logger.error("memos-local: bootstrap failed", {
        err: state.bootstrapError.message,
        code: duplicate ? err.code : (err as { code?: unknown }).code,
      });
    });
  return state;
}

// ─── Registration ──────────────────────────────────────────────────────────

function register(api: OpenClawPluginApi): void {
  let state = readSharedRuntimeState();
  if (!state) {
    state = createSharedRuntimeState(api);
    writeSharedRuntimeState(state);
  } else {
    api.logger.info("memos-local: reusing in-process shared runtime");
  }
  state.registrations += 1;

  // 1. Memory capability (prompt prelude) — register synchronously so the
  //    host immediately knows who owns the memory slot, even if bootstrap
  //    fails later.
  api.registerMemoryCapability?.({
    promptBuilder: ({ availableTools }) => {
      const hasSearch = availableTools.has("memos_search");
      const hasGet = availableTools.has("memos_get");
      const hasTimeline = availableTools.has("memos_timeline");
      const hasEnv = availableTools.has("memos_environment");
      const hasSkillList = availableTools.has("memos_skill_list");
      const hasSkillGet = availableTools.has("memos_skill_get");
      if (!hasSearch && !hasGet && !hasTimeline && !hasEnv && !hasSkillList && !hasSkillGet) {
        return [];
      }
      const lines: string[] = [
        "## Memory (MemOS Local)",
        "This workspace uses MemOS Local — a self-evolving layered memory (L1/L2/L3 + Skills).",
      ];
      if (hasSearch) {
        lines.push(
          "- `memos_search` — search prior traces, policies, world models, and skills when prior experience is likely relevant.",
        );
      }
      if (hasEnv) {
        lines.push(
          "- `memos_environment` — list / query accumulated environment knowledge " +
            "(project layout, behavioural rules, constraints). Use before exploring an unfamiliar area.",
        );
      }
      if (hasGet || hasTimeline) {
        lines.push(
          "- `memos_get` / `memos_timeline` — fetch full bodies + episode timelines.",
        );
      }
      if (hasSkillList) {
        lines.push(
          "- `memos_skill_list` — list MemOS-crystallized skills learned from prior runs.",
        );
      }
      if (hasSkillGet) {
        lines.push(
          "- `memos_skill_get` — load the full invocation guide for a MemOS skill.",
        );
      }
      lines.push(
        "- Prefer concrete recalled memory when it is present. For standalone math tasks with no recalled memory, solve directly instead of searching an empty store.",
        "",
      );
      return lines;
    },
  });

  // 2. Kick off core bootstrap. OpenClaw only accepts tool / hook
  //    registration during the synchronous `register(api)` window, so
  //    tools register a shell now and wait for runtime inside execute().
  const ensureRuntime = async (): Promise<PluginRuntime | null> => {
    if (state.runtime) return state.runtime;
    await state.bootstrapPromise;
    return state.runtime;
  };

  registerOpenClawTools(api, {
    agent: "openclaw",
    getCore: async () => (await ensureRuntime())?.core ?? null,
    log: api.logger,
  });

  // 3. Hooks — every handler matches the upstream `PluginHookHandlerMap`
  //    signature so OpenClaw's type-check passes in a monorepo install.
  api.on("before_prompt_build", async (event, ctx) => {
    const r = await ensureRuntime();
    if (!r) return;
    return r.bridge.handleBeforePrompt(event, ctx);
  });

  api.on("agent_end", async (event, ctx) => {
    const r = await ensureRuntime();
    if (!r) return;
    await r.bridge.handleAgentEnd(event, ctx);
  });

  api.on("before_tool_call", async (event, ctx) => {
    const r = await ensureRuntime();
    if (!r) return;
    r.bridge.handleBeforeToolCall(event, ctx);
  });

  api.on("after_tool_call", async (event, ctx) => {
    const r = await ensureRuntime();
    if (!r) return;
    await r.bridge.handleAfterToolCall(event, ctx);
  });

  api.on("tool_result_persist", async (event, ctx) => {
    const r = await ensureRuntime();
    if (!r) return;
    return r.bridge.handleToolResultPersist(event, ctx);
  });

  api.on("session_start", async (event, ctx) => {
    const r = await ensureRuntime();
    if (!r) return;
    await r.bridge.handleSessionStart(event, ctx);
  });

  api.on("session_end", async (event, ctx) => {
    const r = await ensureRuntime();
    if (!r) return;
    await r.bridge.handleSessionEnd(event, ctx);
  });

  api.on("subagent_spawned", async (event, ctx) => {
    const r = await ensureRuntime();
    if (!r) return;
    r.bridge.handleSubagentSpawned(event, ctx);
  });

  api.on("subagent_ended", async (event, ctx) => {
    const r = await ensureRuntime();
    if (!r) return;
    await r.bridge.handleSubagentEnded(event, ctx);
  });

  // 4. Service — lets the host flush + wait for ready and shut us down.
  //
  // OpenClaw's current loader (≥ 2026.4) keys the service registry by
  // `service.id` and calls `id.trim()` unconditionally. A missing `id`
  // field is the classic "TypeError: Cannot read properties of
  // undefined (reading 'trim')" reported as
  //   [plugins] memos-local-plugin failed during register …
  // Earlier drafts of the SDK used `name` as the primary field, so we
  // fill both to stay compatible across versions.
  api.registerService?.({
    id: "memos-local",
    name: "memos-local",
    async start() {
      await state.bootstrapPromise;
      if (state.bootstrapError) throw state.bootstrapError;
    },
    async stop() {
      state.registrations = Math.max(0, state.registrations - 1);
      if (state.registrations > 0) return;
      const runtimeToStop = state.runtime;
      writeSharedRuntimeState(null);
      if (runtimeToStop) await runtimeToStop.shutdown();
    },
  });
}

// ─── Default export consumed by the host ──────────────────────────────────

/**
 * Module shape mirrors `openclaw/src/plugin-sdk/plugin-entry.ts::
 * DefinedPluginEntry`. When built into the OpenClaw monorepo the host
 * calls `module.default.register(api)` with a real `OpenClawPluginApi`.
 */
const plugin: DefinedPluginEntry = {
  id: PLUGIN_ID,
  name: "MemOS Local",
  description:
    "Reflect2Evolve memory plugin — L1 traces, L2 policies, L3 world models, " +
    "skill crystallization, three-tier retrieval, decision repair.",
  register,
};

export default plugin;

/** Re-export the plain factory for tests / custom hosts. */
export function defineMemosLocalOpenClawPlugin(
  overrides?: Partial<DefinePluginEntryOptions>,
): DefinedPluginEntry {
  return {
    id: overrides?.id ?? PLUGIN_ID,
    name: overrides?.name ?? "MemOS Local",
    description: overrides?.description ?? plugin.description,
    register: overrides?.register ?? register,
  };
}
