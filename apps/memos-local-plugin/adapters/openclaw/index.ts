/**
 * OpenClaw plugin entry point — Reflect2Evolve core.
 *
 * Minimal responsibilities (V7 §0.2 + §2.6):
 *   1. Connect to the shared OpenClaw runtime daemon. The daemon is the only
 *      owner of `MemoryCore`, SQLite, migrations, providers and workers for a
 *      resolved home (`~/.openclaw/memos-plugin/` by default).
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
  OPENCLAW_PLUGIN_CONFIG_SCHEMA,
  resolveOpenClawPluginConfig,
} from "./plugin-config.js";
import { createRemoteMemoryCore } from "./remote-core.js";
import { connectSharedOpenClawRuntime } from "./runtime-client.js";
import { registerOpenClawTools } from "./tools.js";
import type {
  DefinedPluginEntry,
  DefinePluginEntryOptions,
  OpenClawPluginApi,
} from "./openclaw-api.js";

import { resolveHome } from "../../core/config/index.js";
import type { OpenClawRuntimeCore } from "./runtime-core.js";

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
  core: OpenClawRuntimeCore;
  bridge: BridgeHandle;
  shutdown: () => Promise<void>;
}

async function createRuntime(
  api: OpenClawPluginApi,
  featureConfig: ReturnType<typeof resolveOpenClawPluginConfig>,
): Promise<PluginRuntime> {
  const client = await connectSharedOpenClawRuntime(resolveHome("openclaw"));
  const core = createRemoteMemoryCore(client);
  const bridge = createOpenClawBridge({
    agent: "openclaw",
    core,
    log: api.logger,
    memorySearchEnabled: featureConfig.memorySearchEnabled,
    memoryAddEnabled: featureConfig.memoryAddEnabled,
  });
  return {
    core,
    bridge,
    async shutdown() {
      client.close();
    },
  };
}

// ─── Registration ──────────────────────────────────────────────────────────

function register(api: OpenClawPluginApi): void {
  // Non-full discovery/setup loads must not acquire the runtime lock, open the
  // database, run migrations or bind the viewer port. Older OpenClaw hosts do
  // not provide registrationMode and retain the existing full-runtime path.
  if (api.registrationMode && api.registrationMode !== "full") return;

  const featureConfig = resolveOpenClawPluginConfig(api.pluginConfig);

  // 1. Memory capability (prompt prelude) — register synchronously so the
  //    host immediately knows who owns the memory slot, even if bootstrap
  //    fails later.
  api.registerMemoryCapability?.({
    promptBuilder: ({ availableTools }) => {
      if (!featureConfig.memorySearchEnabled) return [];
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
          "- `memos_search` — search prior traces, policies, world models, and skills.",
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
        "- Prefer recalled memory over assuming prior context is unavailable.",
        "",
      );
      return lines;
    },
  });

  // 2. Register synchronously, but connect to/start the shared runtime lazily.
  //    Discovery and remote CLI client processes load plugin definitions too;
  //    eager bootstrap here would incorrectly turn them into DB owners.
  let runtime: PluginRuntime | null = null;
  let bootstrapError: Error | null = null;
  let bootstrapPromise: Promise<void> | null = null;
  const startRuntime = (): Promise<void> => {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = createRuntime(api, featureConfig)
      .then((created) => {
        runtime = created;
        api.logger.info("memos-local: plugin ready (shared runtime)");
      })
      .catch((err) => {
        bootstrapError = err instanceof Error ? err : new Error(String(err));
        api.logger.error("memos-local: bootstrap failed", {
          err: bootstrapError.message,
          code: (err as { code?: unknown }).code,
        });
        throw bootstrapError;
      });
    return bootstrapPromise;
  };

  const ensureRuntime = async (): Promise<PluginRuntime | null> => {
    if (runtime) return runtime;
    await startRuntime();
    return runtime;
  };

  /**
   * Helper for **void / fire-and-forget** hooks: dispatch `fn` against the
   * runtime as soon as bootstrap finishes (already finished → next tick).
   * Errors are logged at WARN and swallowed — they must not surface to
   * OpenClaw's hook runner because the listener itself has already
   * returned synchronously.
   *
   * `label` is used solely for log context so a misbehaving hook is
   * findable in the gateway log.
   */
  const runWhenReady = async (
    fn: (r: PluginRuntime) => void | Promise<void>,
    label: string,
    propagate = false,
  ): Promise<void> => {
    try {
      const r = await ensureRuntime();
      if (!r) return;
      await fn(r);
    } catch (err) {
      api.logger.warn(`memos-local: hook ${label} failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      if (propagate) throw err;
    }
  };

  registerOpenClawTools(api, {
    agent: "openclaw",
    getCore: async () => (await ensureRuntime())?.core ?? null,
    log: api.logger,
    memorySearchEnabled: featureConfig.memorySearchEnabled,
  });

  // 3. Hooks — every handler matches the upstream `PluginHookHandlerMap`
  //    signature so OpenClaw's type-check passes in a monorepo install.
  //
  // Two upstream constraints govern the registration style here:
  //   (a) `tool_result_persist` is a **value-returning sync hook**.
  //       OpenClaw's hook runner inspects the return value with
  //       `isPromiseLike(ret)` and ignores it when the handler returns a
  //       Promise — so declaring this listener `async` silently disables
  //       the "append memos_search hint after repeated tool failures"
  //       feature. We register a **synchronous** wrapper that calls the
  //       (already sync) `bridge.handleToolResultPersist` directly. If
  //       bootstrap hasn't completed yet, the hook is a no-op (matches
  //       the legacy adapter — runtime not ready means no hint to
  //       inject).
  //   (b) `agent_end` has a hard-coded 30 s timeout. The pipeline now
  //       acknowledges it after raw L1 + durable evolution-job commit;
  //       model-bound enrichment runs behind the SQLite worker lease.
  //       Await this short acknowledgement so one-shot hosts cannot exit
  //       before the capture request itself has reached durable storage.
  //
  // `before_prompt_build` stays async-await because it MUST return the
  // `prependContext` for OpenClaw to inject — it is a value-returning
  // hook, not a void hook, and OpenClaw is willing to await its result
  // (the timeout is laxer than `agent_end`'s 30 s budget).
  api.on("before_prompt_build", async (event, ctx) => {
    const r = await ensureRuntime();
    if (!r) return;
    return r.bridge.handleBeforePrompt(event, ctx);
  });

  api.on("agent_end", async (event, ctx) => {
    await runWhenReady(
      (r) => r.bridge.handleAgentEnd(event, ctx),
      "agent_end",
      true,
    );
  });

  api.on("before_tool_call", (event, ctx) => {
    // `handleBeforeToolCall` is sync and cheap (Map.set + timestamp);
    // we still gate on runtime presence by deferring to ensureRuntime
    // when bootstrap is in flight. The fire-and-forget wrapper keeps
    // the listener void-shaped for OpenClaw.
    void runWhenReady((r) => {
      r.bridge.handleBeforeToolCall(event, ctx);
    }, "before_tool_call");
  });

  api.on("after_tool_call", (event, ctx) => {
    void runWhenReady((r) => r.bridge.handleAfterToolCall(event, ctx), "after_tool_call");
  });

  // tool_result_persist is value-returning AND synchronous on
  // OpenClaw's side — do NOT make this async. Bridge handler is
  // already sync, so we can invoke it directly when the runtime is
  // ready and return undefined otherwise.
  api.on("tool_result_persist", (event, ctx) => {
    if (!runtime) return; // bootstrap not finished — nothing to inject
    return runtime.bridge.handleToolResultPersist(event, ctx);
  });

  api.on("session_start", (event, ctx) => {
    void runWhenReady((r) => r.bridge.handleSessionStart(event, ctx), "session_start");
  });

  api.on("session_end", (event, ctx) => {
    void runWhenReady((r) => r.bridge.handleSessionEnd(event, ctx), "session_end");
  });

  api.on("subagent_spawned", (event, ctx) => {
    void runWhenReady((r) => {
      r.bridge.handleSubagentSpawned(event, ctx);
    }, "subagent_spawned");
  });

  api.on("subagent_ended", (event, ctx) => {
    void runWhenReady((r) => r.bridge.handleSubagentEnded(event, ctx), "subagent_ended");
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
      await startRuntime();
      if (bootstrapError) throw bootstrapError;
    },
    async stop() {
      if (runtime) await runtime.shutdown();
      runtime = null;
      bootstrapPromise = null;
      bootstrapError = null;
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
  configSchema: OPENCLAW_PLUGIN_CONFIG_SCHEMA,
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
    configSchema: overrides?.configSchema ?? OPENCLAW_PLUGIN_CONFIG_SCHEMA,
    register: overrides?.register ?? register,
  };
}
