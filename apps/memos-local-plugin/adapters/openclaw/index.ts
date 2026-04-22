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
import { startHttpServer, type ServerHandle } from "../../server/index.js";
import type { MemoryCore } from "../../agent-contract/memory-core.js";

// ─── Plugin metadata ───────────────────────────────────────────────────────

export const PLUGIN_ID = "memos-local-plugin";
export const PLUGIN_VERSION = "2.0.0-beta.1";

// ─── Runtime state (per plugin load) ───────────────────────────────────────

interface PluginRuntime {
  core: MemoryCore;
  bridge: BridgeHandle;
  server: ServerHandle | null;
  shutdown: () => Promise<void>;
}

/** Locate the bundled viewer static assets relative to the plugin root. */
/**
 * Announce our fallback port to the hub running on `hubPort`. The
 * hub uses this to reverse-proxy `/openclaw/*` requests to us.
 * Retry a few times because hub boot may race us slightly.
 */
async function tryHubRegister(opts: {
  hubPort: number;
  selfPort: number;
  selfAgent: "openclaw" | "hermes";
  version: string;
  log: { info: (msg: string, ctx?: Record<string, unknown>) => void; warn: (msg: string, ctx?: Record<string, unknown>) => void };
}): Promise<void> {
  const { hubPort, selfPort, selfAgent, version, log } = opts;
  const body = JSON.stringify({ agent: selfAgent, port: selfPort, version });
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${hubPort}/api/v1/hub/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.ok) {
        log.info(
          `memos-local: registered with hub @ :${hubPort} as ${selfAgent} (self port ${selfPort})`,
        );
        return;
      }
      log.warn(
        `memos-local: hub register returned ${res.status}; retrying in 2 s`,
      );
    } catch (err) {
      log.warn(
        `memos-local: hub unreachable (${(err as Error).message}); retrying…`,
      );
    }
    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
  }
  log.warn(
    `memos-local: could not reach hub @ :${hubPort} after retries; the /${selfAgent}/ URL on the hub port will not work`,
  );
}

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

  // Start the HTTP viewer on the configured port. Failure here is
  // non-fatal — memory still works without the UI.
  let server: ServerHandle | null = null;
  try {
    server = await startHttpServer(
      {
        core,
        home,
        logTail: () => memoryBuffer().tail({ limit: 200 }),
      },
      {
        port: config.viewer.port,
        host: config.viewer.bindHost,
        staticRoot: resolveViewerStaticRoot(),
        // Declare this agent so the server applies the
        // /{agent}/… path prefix + reverse proxy (see
        // `docs/MULTI_AGENT_VIEWER.md`).
        agent: "openclaw",
      },
    );
    api.logger.info(`memos-local: Memory Viewer → ${server.url}`);

    // If we ended up on a fallback port (because the configured
    // hub port was already taken by another agent's viewer),
    // register ourselves with the hub so it can route
    // `/openclaw/*` to us.
    if (server.port !== config.viewer.port) {
      await tryHubRegister({
        hubPort: config.viewer.port,
        selfPort: server.port,
        selfAgent: "openclaw",
        version: PLUGIN_VERSION,
        log: api.logger,
      });
    }
  } catch (err) {
    api.logger.warn(
      `memos-local: viewer failed to start on port ${config.viewer.port}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  return {
    core,
    bridge,
    server,
    async shutdown() {
      try {
        if (server) await server.close();
      } catch (err) {
        api.logger.warn("memos-local: viewer close error", {
          err: err instanceof Error ? err.message : String(err),
        });
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
