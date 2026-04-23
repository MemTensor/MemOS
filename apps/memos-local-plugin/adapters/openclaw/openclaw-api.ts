/**
 * Local mirror of the OpenClaw plugin SDK surface we depend on.
 *
 * The real types live in `openclaw/plugin-sdk` (package in the OpenClaw
 * monorepo at `packages/plugin-sdk/src/plugin-entry.ts` → re-exporting
 * `src/plugin-sdk/*` → `src/plugins/types.ts`). We deliberately do NOT
 * take a compile-time dependency on that package so this plugin can
 * build, test, and ship without the OpenClaw tree present.
 *
 * The names and shapes below are kept faithful to the upstream API
 * (verified against openclaw `src/plugins/types.ts` and
 * `src/plugins/hook-types.ts`). When you update this file:
 *
 *   1. cross-check the upstream SDK at `packages/plugin-sdk/src/...`;
 *   2. update only the fields the adapter actually reads (keep the
 *      surface minimal so the type-check doesn't drift with upstream);
 *   3. add a smoke test in `tests/unit/adapters/openclaw-bridge.test.ts`.
 *
 * Anything marked ` // opaque` is passed through without inspection.
 */
import type { Static, TSchema } from "@sinclair/typebox";

// ─── Host logger ───────────────────────────────────────────────────────────

export interface HostLogger {
  trace: (msg: string, ctx?: Record<string, unknown>) => void;
  debug: (msg: string, ctx?: Record<string, unknown>) => void;
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
}

// ─── Agent tool shape (subset of @mariozechner/pi-agent-core AnyAgentTool) ─
//
// OpenClaw forwards `registerTool` to the pi-agent-core runner. The real
// type is discriminated on `kind`; for memory-grade tools we always use
// the default "simple function" flavour (no-approval, server-side), so we
// only model that one here.

export interface AgentToolDescriptor<I extends TSchema = TSchema, O extends TSchema = TSchema> {
  name: string;
  /** Human-readable label used by the UI. */
  label?: string;
  description: string;
  /** TypeBox schema for tool parameters (OpenClaw uses TypeBox natively). */
  parameters: I;
  /** Optional declared output schema. */
  returns?: O;
  /**
   * Pi-agent-core passes `(toolCallId, params)`. We expose both here —
   * ignore `toolCallId` if you don't need it for correlation.
   */
  execute: (toolCallId: string, params: Static<I>) => Promise<unknown> | unknown;
}

/**
 * Factory form of tool registration (`AnyAgentTool` in pi-agent-core).
 *
 * OpenClaw invokes this factory once per plugin activation with a trusted
 * context. We use `any` for the tool's schema generics because the factory
 * is called from non-generic host code — concrete schemas stay available
 * inside each tool's own `execute` via `Static<typeof parameters>`.
 */
export type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | AgentToolDescriptor<any, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | AgentToolDescriptor<any, any>[]
  | null
  | undefined;

export interface OpenClawPluginToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  agentDir?: string;
  messageChannel?: string;
  sandboxed?: boolean;
  // opaque: other fields are ignored.
}

export interface OpenClawPluginToolOptions {
  name?: string;
  names?: string[];
  optional?: boolean;
}

// ─── Hook contracts (subset, aligned with upstream `hook-types.ts`) ────────

/** Hook names we actually subscribe to. */
export type OpenClawHookName =
  | "before_prompt_build"
  | "agent_end"
  | "before_tool_call"
  | "after_tool_call"
  | "session_start"
  | "session_end"
  | "subagent_spawned"
  | "subagent_ended";

export interface PluginHookAgentContext {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}

export interface PluginHookSessionContext {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
}

export interface PluginHookToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}

export interface PluginHookSubagentContext {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
}

export interface BeforePromptBuildEvent {
  prompt: string;
  messages: unknown[]; // opaque AgentMessage[]
}

/** The only return shape OpenClaw reads back from `before_prompt_build`. */
export interface BeforePromptBuildResult {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}

export interface AgentEndEvent {
  messages: unknown[]; // opaque AgentMessage[]
  success: boolean;
  error?: string;
  durationMs?: number;
}

export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

export interface AfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface SessionStartEvent {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
}

export type SessionEndReason =
  | "new"
  | "reset"
  | "idle"
  | "daily"
  | "compaction"
  | "deleted"
  | "unknown";

export interface SessionEndEvent {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
  reason?: SessionEndReason;
  sessionFile?: string;
  transcriptArchived?: boolean;
  nextSessionId?: string;
  nextSessionKey?: string;
}

export interface SubagentSpawnedEvent {
  childSessionKey: string;
  agentId: string;
  runId: string;
  mode: "run" | "session";
  label?: string;
}

export interface SubagentEndedEvent {
  targetSessionKey: string;
  targetKind: "subagent" | "acp";
  reason: string;
  runId?: string;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
}

/** Handler map — each hook has its own event + ctx shape. */
export interface OpenClawHookHandlerMap {
  before_prompt_build: (
    event: BeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ) => BeforePromptBuildResult | void | Promise<BeforePromptBuildResult | void>;
  agent_end: (event: AgentEndEvent, ctx: PluginHookAgentContext) => void | Promise<void>;
  before_tool_call: (
    event: BeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ) => void | Promise<void>;
  after_tool_call: (
    event: AfterToolCallEvent,
    ctx: PluginHookToolContext,
  ) => void | Promise<void>;
  session_start: (
    event: SessionStartEvent,
    ctx: PluginHookSessionContext,
  ) => void | Promise<void>;
  session_end: (
    event: SessionEndEvent,
    ctx: PluginHookSessionContext,
  ) => void | Promise<void>;
  subagent_spawned: (
    event: SubagentSpawnedEvent,
    ctx: PluginHookSubagentContext,
  ) => void | Promise<void>;
  subagent_ended: (
    event: SubagentEndedEvent,
    ctx: PluginHookSubagentContext,
  ) => void | Promise<void>;
}

// ─── Memory capability (prompt prelude + runtime) ─────────────────────────

export interface MemoryPromptSectionBuilder {
  (input: { availableTools: Set<string>; citationsMode?: string }): string[];
}

export interface MemoryPluginCapability {
  /** Static system-prompt-section contribution. */
  promptBuilder?: MemoryPromptSectionBuilder;
  /** Additional runtime adapters — kept opaque; we don't use them today. */
  runtime?: unknown;
  flushPlanResolver?: unknown;
  publicArtifacts?: unknown;
}

// ─── Service (long-lived background hook) ─────────────────────────────────

/**
 * Service descriptor shape as of OpenClaw 2026.4.x. Earlier SDK drafts
 * called this field `name`; the live runtime reads `id`. We publish
 * both so downstream callers that were written against the older type
 * also keep working.
 */
export interface ServiceDescriptor {
  /** Stable identifier the host uses as the registry key. Required. */
  id: string;
  /** Human-readable label. Defaults to `id` when omitted. */
  name?: string;
  start?: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
}

// ─── The façade we register against ───────────────────────────────────────

export interface OpenClawPluginApi {
  /** Plugin id + metadata the host injected. */
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** Plugin-scoped config (from `config.yaml` if present). */
  pluginConfig?: Record<string, unknown>;
  logger: HostLogger;

  registerTool(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: AgentToolDescriptor<any, any> | OpenClawPluginToolFactory,
    opts?: OpenClawPluginToolOptions,
  ): void;

  on<K extends OpenClawHookName>(
    hookName: K,
    handler: OpenClawHookHandlerMap[K],
    opts?: { priority?: number },
  ): void;

  registerMemoryCapability?(capability: MemoryPluginCapability): void;
  registerService?(svc: ServiceDescriptor): void;
}

// ─── Entry helper shape (definePluginEntry return type) ───────────────────

export interface DefinePluginEntryOptions {
  id: string;
  name: string;
  description: string;
  configSchema?: unknown;
  register: (api: OpenClawPluginApi) => void;
}

export interface DefinedPluginEntry {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
  configSchema?: unknown;
}
