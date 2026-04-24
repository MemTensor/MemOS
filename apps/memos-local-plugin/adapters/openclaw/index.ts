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
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenClawBridge, type BridgeHandle } from "./bridge.js";
import { registerOpenClawTools } from "./tools.js";
import type {
  DefinedPluginEntry,
  DefinePluginEntryOptions,
  OpenClawPluginApi,
} from "./openclaw-api.js";

import { bootstrapMemoryCoreFull } from "../../core/pipeline/index.js";
import { rootLogger, memoryBuffer } from "../../core/logger/index.js";
import type { MemoryCore } from "../../agent-contract/memory-core.js";
import { startHttpServer } from "../../server/http.js";
import type { ServerHandle } from "../../server/types.js";

// ─── Plugin metadata ───────────────────────────────────────────────────────

export const PLUGIN_ID = "memos-local-plugin";
export const PLUGIN_VERSION = "2.0.0-beta.1";

// ─── Runtime state (per plugin load) ───────────────────────────────────────

interface PluginRuntime {
  core: MemoryCore;
  bridge: BridgeHandle;
  /**
   * The viewer HTTP server. May be `null` if the configured port was
   * already in use at boot — in that case OpenClaw runs headless
   * (memory still works, just no UI). We don't retry: the user can
   * free the port and restart the gateway.
   */
  viewer: ServerHandle | null;
  shutdown: () => Promise<void>;
}

/** Locate the bundled viewer static assets relative to the plugin root. */
function resolveViewerStaticRoot(): string | undefined {
  // When the plugin ships as an npm tarball the built viewer sits at
  // `<plugin>/web/dist/` (included via `package.json::files`). During local
  // development `web/dist` is only present after `npm run build:web`.
  // Either way we resolve relative to this file's directory.
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const adapterDir = path.dirname(thisFile); // .../adapters/openclaw
    const candidate = path.resolve(adapterDir, "..", "..", "web", "dist");
    return candidate;
  } catch {
    return undefined;
  }
}

async function createRuntime(api: OpenClawPluginApi): Promise<PluginRuntime> {
  const log = rootLogger.child({ channel: "adapters.openclaw" });
  log.info("plugin.bootstrap", { version: PLUGIN_VERSION });

  // Bootstrap core — returns `{ core, home, config }` so we know which
  // viewer port to bind.
  const { core, config, home } = await bootstrapMemoryCoreFull({
    agent: "openclaw",
    pkgVersion: PLUGIN_VERSION,
  });
  await core.init();

  const bridge = createOpenClawBridge({
    agent: "openclaw",
    core,
    log: api.logger,
  });

  // OpenClaw's viewer port is fixed at :18799 (hermes uses :18800).
  // We ignore `config.viewer.port` for the same reason `bridge.cts`
  // does: old config.yaml files baked in the legacy single-port
  // :18799 used by both agents, and we don't want hermes to collide
  // with us because of stale YAML.
  const OPENCLAW_VIEWER_PORT = 18799;
  let viewer: ServerHandle | null = null;
  try {
    viewer = await startHttpServer(
      {
        core,
        home,
        logTail: () => memoryBuffer().tail({ limit: 200 }),
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
      api.logger.warn(
        `memos-local: viewer port :${OPENCLAW_VIEWER_PORT} is already in use — ` +
          `running headless. Free the port and restart the gateway to expose it.`,
      );
    } else {
      api.logger.error("memos-local: viewer failed to start", {
        err: e?.message ?? String(err),
      });
    }
  }

  return {
    core,
    bridge,
    viewer,
    async shutdown() {
      if (viewer) {
        try {
          await viewer.close();
        } catch (err) {
          api.logger.warn("memos-local: viewer close error", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
        await core.shutdown();
      } catch (err) {
        api.logger.warn("memos-local: shutdown error", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

// ─── Registration ──────────────────────────────────────────────────────────

function register(api: OpenClawPluginApi): void {
  // 1. Memory capability (prompt prelude) — register synchronously so the
  //    host immediately knows who owns the memory slot, even if bootstrap
  //    fails later.
  api.registerMemoryCapability?.({
    promptBuilder: ({ availableTools }) => {
      const hasSearch = availableTools.has("memory_search");
      const hasGet = availableTools.has("memory_get");
      const hasTimeline = availableTools.has("memory_timeline");
      const hasEnv = availableTools.has("memory_environment");
      if (!hasSearch && !hasGet && !hasTimeline && !hasEnv) return [];
      const lines: string[] = [
        "## Memory (MemOS Local)",
        "This workspace uses MemOS Local — a self-evolving layered memory (L1/L2/L3 + Skills).",
      ];
      if (hasSearch) {
        lines.push(
          "- `memory_search` — search prior traces, policies, world models, and skills.",
        );
      }
      if (hasEnv) {
        lines.push(
          "- `memory_environment` — list / query accumulated environment knowledge " +
            "(project layout, behavioural rules, constraints). Use before exploring an unfamiliar area.",
        );
      }
      if (hasGet || hasTimeline) {
        lines.push(
          "- `memory_get` / `memory_timeline` — fetch full bodies + episode timelines.",
        );
      }
      lines.push(
        "- Prefer recalled memory over assuming prior context is unavailable.",
        "",
      );
      return lines;
    },
  });

  // 2. Kick off core bootstrap. We register tools + hooks against the
  //    resulting runtime. Hooks proxy to the bridge and gracefully no-op
  //    while bootstrap is in-flight — the host must still register them
  //    before any turn can fire.
  let runtime: PluginRuntime | null = null;
  let bootstrapError: Error | null = null;
  const bootstrapPromise = createRuntime(api)
    .then((r) => {
      runtime = r;
      registerOpenClawTools(api, {
        agent: "openclaw",
        core: r.core,
        log: api.logger,
      });
      api.logger.info("memos-local: plugin ready");
    })
    .catch((err) => {
      bootstrapError = err instanceof Error ? err : new Error(String(err));
      api.logger.error("memos-local: bootstrap failed", {
        err: bootstrapError.message,
      });
    });

  const ensureRuntime = async (): Promise<PluginRuntime | null> => {
    if (runtime) return runtime;
    await bootstrapPromise;
    return runtime;
  };

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
      await bootstrapPromise;
      if (bootstrapError) throw bootstrapError;
    },
    async stop() {
      if (runtime) await runtime.shutdown();
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
