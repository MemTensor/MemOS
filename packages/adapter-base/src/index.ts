import type {
  AdapterContext,
  MemoryQuery,
  MemoryEvent,
  MemoryHit,
  MemorySearchResult,
  PromptInjection,
} from "@memtensor/memos-schema";

// ─── MemoryCore interface ───
// This will be satisfied by the actual MemoryCore class (packages/memos-core)
// or by the bridge client (Python adapter wrapping JSON-RPC calls).

export interface IMemoryCore {
  search(query: MemoryQuery): Promise<MemorySearchResult>;
  ingest(event: MemoryEvent): Promise<void>;
  buildPrompt(query: MemoryQuery): Promise<PromptInjection>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

// ─── Adapter interface ───

export interface AgentMemoryAdapter {
  readonly appId: string;
  onTurnStart?(hostCtx: unknown): Promise<PromptInjection | void>;
  onTurnEnd?(hostCtx: unknown): Promise<void>;
  registerTools?(hostApi: unknown): Promise<void>;
}

// ─── Base adapter ───

export abstract class BaseMemoryAdapter implements AgentMemoryAdapter {
  abstract readonly appId: string;

  constructor(protected core: IMemoryCore) {}

  async recall(ctx: AdapterContext): Promise<PromptInjection> {
    return this.core.buildPrompt({
      app: ctx.app,
      query: ctx.latestUserPrompt ?? "",
      cwd: ctx.cwd,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    });
  }

  async capture(ctx: AdapterContext): Promise<void> {
    if (!ctx.conversationMessages?.length) return;
    await this.core.ingest({
      app: ctx.app,
      agent: ctx.agent ?? this.appId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      workspaceId: ctx.workspaceId,
      cwd: ctx.cwd,
      timestamp: Date.now(),
      messages: ctx.conversationMessages.map((m) => ({
        role: m.role as "user" | "assistant" | "tool" | "system",
        content: m.content,
      })),
    });
  }

  async search(ctx: AdapterContext): Promise<MemorySearchResult> {
    return this.core.search({
      app: ctx.app,
      query: ctx.latestUserPrompt ?? "",
      cwd: ctx.cwd,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    });
  }

  // ─── Subclass must implement ───

  /** Map host-specific context into the unified AdapterContext. */
  abstract normalizeHostContext(hostCtx: unknown): AdapterContext;

  /** Inject recalled memory into the host's prompt or context object. */
  abstract injectPrompt(injection: PromptInjection, hostCtx: unknown): void;

  /** Extract conversation messages from the host's turn-end context. */
  abstract extractTurnMessages(
    hostCtx: unknown,
  ): Array<{ role: string; content: string }>;

  // ─── Default lifecycle hooks ───

  async onTurnStart(hostCtx: unknown): Promise<PromptInjection | void> {
    const ctx = this.normalizeHostContext(hostCtx);
    const injection = await this.recall(ctx);
    if (injection.hitCount > 0) {
      this.injectPrompt(injection, hostCtx);
    }
    return injection;
  }

  async onTurnEnd(hostCtx: unknown): Promise<void> {
    const ctx = this.normalizeHostContext(hostCtx);
    ctx.conversationMessages = this.extractTurnMessages(hostCtx);
    await this.capture(ctx);
  }
}

export type { AdapterContext, MemoryQuery, MemoryEvent, MemoryHit, MemorySearchResult, PromptInjection };
