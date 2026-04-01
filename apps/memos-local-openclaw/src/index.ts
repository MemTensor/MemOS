import { v4 as uuid } from "uuid";
import { buildContext } from "./config";
import { ensureSqliteBinding } from "./storage/ensure-binding";
import { SqliteStore } from "./storage/sqlite";
import { Embedder } from "./embedding";
import { IngestWorker } from "./ingest/worker";
import { RecallEngine } from "./recall/engine";
import { captureMessages } from "./capture";
import { createMemorySearchTool, createMemoryTimelineTool, createMemoryGetTool, createNetworkMemoryDetailTool } from "./tools";
import type { MemosLocalConfig, ToolDefinition, Logger } from "./types";
import type { HostModelsConfig } from "./openclaw-api";

export interface MemosLocalPlugin {
  id: string;
  tools: ToolDefinition[];
  onConversationTurn: (messages: Array<{ role: string; content: string }>, sessionKey?: string, owner?: string) => void;
  /** Wait for all pending ingest operations to complete. */
  flush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export interface PluginInitOptions {
  stateDir?: string;
  workspaceDir?: string;
  config?: Partial<MemosLocalConfig>;
  log?: Logger;
  hostModels?: HostModelsConfig;
}

/**
 * Initialize the memos-local plugin.
 *
 * Typical usage inside OpenClaw plugin lifecycle:
 *
 * ```ts
 * import { initPlugin } from "@memos/local-openclaw";
 *
 * export default function activate(ctx) {
 *   const plugin = initPlugin({
 *     stateDir: ctx.stateDir,
 *     workspaceDir: ctx.workspaceDir,
 *     config: ctx.pluginConfig,
 *     log: ctx.log,
 *   });
 *   ctx.registerTools(plugin.tools);
 *   ctx.onConversationTurn((msgs, session) => {
 *     plugin.onConversationTurn(msgs, session);
 *   });
 *   ctx.onDeactivate(() => plugin.shutdown());
 * }
 * ```
 */
export function initPlugin(opts: PluginInitOptions = {}): MemosLocalPlugin {
  const stateDir = opts.stateDir ?? defaultStateDir();
  const workspaceDir = opts.workspaceDir ?? process.cwd();
  const ctx = buildContext(stateDir, workspaceDir, opts.config, opts.log, opts.hostModels);

  ctx.log.info("Initializing memos-local plugin...");

  ensureSqliteBinding(ctx.log);

  const store = new SqliteStore(ctx.config.storage!.dbPath!, ctx.log);
  const embedder = new Embedder(ctx.config.embedding, ctx.log, ctx.openclawAPI);
  const worker = new IngestWorker(store, embedder, ctx);
  const engine = new RecallEngine(store, embedder, ctx);

  const sharedState = { lastSearchTime: 0 };

  const tools: ToolDefinition[] = [
    createMemorySearchTool(engine, store, ctx, sharedState),
    createMemoryTimelineTool(store),
    createMemoryGetTool(store),
    createNetworkMemoryDetailTool(store, ctx),
  ];

  ctx.log.info(`Plugin ready. DB: ${ctx.config.storage!.dbPath}, Embedding: ${embedder.provider}`);

  return {
    id: "memos-local",

    tools,

    onConversationTurn(
      messages: Array<{ role: string; content: string }>,
      sessionKey?: string,
      owner?: string,
    ): void {
      const session = sessionKey ?? "default";
      const turnId = uuid();
      const tag = ctx.config.capture?.evidenceWrapperTag ?? "STORED_MEMORY";

      const userSearchTime = sharedState.lastSearchTime || 0;
      sharedState.lastSearchTime = 0;

      const captured = captureMessages(messages, session, turnId, tag, ctx.log, owner, userSearchTime);
      if (captured.length > 0) {
        worker.enqueue(captured);
      }
    },

    async flush(): Promise<void> {
      await worker.flush();
    },

    async shutdown(): Promise<void> {
      ctx.log.info("Shutting down memos-local plugin...");
      await worker.flush();
      store.close();
    },
  };
}

function defaultStateDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return `${home}/.openclaw`;
}

// Re-export types for consumers
export type { MemosLocalConfig, ToolDefinition, SearchResult, SearchHit, TimelineResult, GetResult } from "./types";
