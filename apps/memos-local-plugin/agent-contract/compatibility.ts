/**
 * Agent Memory compatibility model.
 *
 * Shared contract for the six integration paradigms in the agent-memory plan.
 */

export type IntegrationMode =
  | "native-integration"
  | "hook-plugin"
  | "mcp"
  | "rest-sdk"
  | "wrapper-proxy"
  | "historical-connector";

export type CompatibilityLevel = "l5" | "l4" | "l3" | "l2" | "l1" | "l0" | "l-1";

export type CapabilitySupport = "strong" | "medium" | "weak" | "n/a";

export type CapabilityPoint =
  | "session.start"
  | "turn.prepare"
  | "tool.observe"
  | "tool.rewrite"
  | "turn.complete"
  | "subagent.prepare"
  | "subagent.complete"
  | "feedback.record"
  | "history.ingest"
  | "history.mine"
  | "memory.promote";

export interface CompatibilitySignals {
  hasAgentLoop?: boolean;
  hasMemoryProvider?: boolean;
  hasLifecycleHooks?: boolean;
  hasMcp?: boolean;
  hasHttpApi?: boolean;
  canWrapProcess?: boolean;
  canProxyProvider?: boolean;
  hasHistoryExport?: boolean;
  canReadLogs?: boolean;
  canRewritePrompt?: boolean;
}

export interface CompatibilityAssessmentInput {
  agentKind?: string;
  signals: CompatibilitySignals;
  preferredMode?: IntegrationMode | null;
  notes?: string[];
}

export interface CompatibilityAssessment {
  agentKind: string;
  displayName: string;
  mode: IntegrationMode | null;
  level: CompatibilityLevel;
  compatible: boolean;
  signals: Required<CompatibilitySignals>;
  coverage: Record<CapabilityPoint, CapabilitySupport>;
  canAutoInject: boolean;
  canAutoCapture: boolean;
  canMineHistory: boolean;
  recommendedNextStep: string;
  notes: string[];
}

export interface AgentProfile {
  agentKind: string;
  displayName: string;
  category: "coding" | "desktop" | "cli" | "editor" | "custom";
  recommendedMode: IntegrationMode;
  defaultSignals: Partial<CompatibilitySignals>;
  recommendedHooks: string[];
  capturePoints: string[];
  injectionPoints: string[];
  notes: string[];
}

export interface AgentIntegrationPlan extends CompatibilityAssessment {
  profile: AgentProfile | null;
  recommendedHooks: string[];
  capturePoints: string[];
  injectionPoints: string[];
  rolloutOrder: string[];
}

const CAPABILITY_POINTS: readonly CapabilityPoint[] = [
  "session.start",
  "turn.prepare",
  "tool.observe",
  "tool.rewrite",
  "turn.complete",
  "subagent.prepare",
  "subagent.complete",
  "feedback.record",
  "history.ingest",
  "history.mine",
  "memory.promote",
];

const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    agentKind: "openclaw",
    displayName: "OpenClaw",
    category: "cli",
    recommendedMode: "native-integration",
    defaultSignals: { hasAgentLoop: true, hasMemoryProvider: true, hasLifecycleHooks: true },
    recommendedHooks: ["before_prompt_build", "agent_turn_prepare", "tool_result_postprocess", "after_turn_commit"],
    capturePoints: ["prompt assembly", "tool execution result", "turn end", "subagent result"],
    injectionPoints: ["system-adjacent memory slot", "developer note", "tool hint"],
    notes: ["Deepest integration path. Best for automatic write-back and prompt shaping."],
  },
  {
    agentKind: "claude-code",
    displayName: "Claude Code",
    category: "cli",
    recommendedMode: "hook-plugin",
    defaultSignals: { hasLifecycleHooks: true, hasMcp: true },
    recommendedHooks: ["before_prompt_build", "after_tool_result", "before_llm_call", "after_turn_commit"],
    capturePoints: ["pre-LLM prompt", "tool result", "conversation end"],
    injectionPoints: ["hook-injected developer text", "memory tool call"],
    notes: ["Hooks are the primary surface; MCP is the fallback for read/write tools."],
  },
  {
    agentKind: "codex-cli",
    displayName: "Codex CLI",
    category: "cli",
    recommendedMode: "hook-plugin",
    defaultSignals: { hasLifecycleHooks: true, canWrapProcess: true },
    recommendedHooks: ["before_prompt_build", "before_tool_call", "after_tool_result", "after_turn_commit"],
    capturePoints: ["prompt build", "tool call", "turn complete"],
    injectionPoints: ["prompt prefix", "tool feedback", "session notes"],
    notes: ["Wrapper fallback helps when host hook coverage is partial."],
  },
  {
    agentKind: "pi",
    displayName: "Pi",
    category: "custom",
    recommendedMode: "native-integration",
    defaultSignals: { hasAgentLoop: true, canProxyProvider: true },
    recommendedHooks: ["agent_turn_prepare", "tool_result_record", "turn_complete"],
    capturePoints: ["LLM stream", "tool result", "final answer"],
    injectionPoints: ["system prompt", "assistant-side context", "tool advice"],
    notes: ["Model-native bridge is the cleanest path when the host exposes its own loop."],
  },
  {
    agentKind: "openhuman",
    displayName: "OpenHuman",
    category: "desktop",
    recommendedMode: "rest-sdk",
    defaultSignals: { hasHttpApi: true, canReadLogs: true },
    recommendedHooks: ["session.sync", "history.export", "background.ingestion"],
    capturePoints: ["session export", "log stream", "history files"],
    injectionPoints: ["server-side memory pull", "manual recall tool"],
    notes: ["History-first integration is the safest default until native hooks are proven."],
  },
  {
    agentKind: "cursor",
    displayName: "Cursor",
    category: "editor",
    recommendedMode: "mcp",
    defaultSignals: { hasMcp: true, hasHttpApi: true },
    recommendedHooks: ["mcp.memory_search", "mcp.memory_get", "mcp.memory_write"],
    capturePoints: ["workspace tool traffic", "file edits", "chat turns"],
    injectionPoints: ["MCP tool results", "sidecar memory search"],
    notes: ["MCP remains the most stable integration surface."],
  },
  {
    agentKind: "gemini-cli",
    displayName: "Gemini CLI",
    category: "cli",
    recommendedMode: "mcp",
    defaultSignals: { hasMcp: true, hasHttpApi: true },
    recommendedHooks: ["mcp.memory_search", "mcp.memory_timeline", "mcp.memory_get"],
    capturePoints: ["MCP tool calls", "turn end", "log output"],
    injectionPoints: ["MCP response", "session-local memory note"],
    notes: ["Prefer standard MCP tools over process wrapping."],
  },
  {
    agentKind: "opencode",
    displayName: "OpenCode",
    category: "cli",
    recommendedMode: "mcp",
    defaultSignals: { hasMcp: true, hasLifecycleHooks: true },
    recommendedHooks: ["before_prompt_build", "mcp.memory_search", "after_turn_commit"],
    capturePoints: ["prompt build", "MCP tool results", "final assistant output"],
    injectionPoints: ["prompt injection", "MCP memory tool"],
    notes: ["Can use both hook and MCP surfaces when available."],
  },
  {
    agentKind: "cline",
    displayName: "Cline",
    category: "editor",
    recommendedMode: "mcp",
    defaultSignals: { hasMcp: true, hasHttpApi: true },
    recommendedHooks: ["mcp.memory_search", "mcp.memory_timeline", "mcp.memory_get"],
    capturePoints: ["tool execution", "prompt composition", "chat completion"],
    injectionPoints: ["MCP context fetch", "sidecar session memory"],
    notes: ["Works as a tool-centric connector rather than a deep host hook."],
  },
  {
    agentKind: "goose",
    displayName: "Goose",
    category: "cli",
    recommendedMode: "mcp",
    defaultSignals: { hasMcp: true, canWrapProcess: true },
    recommendedHooks: ["mcp.memory_search", "before_prompt_build", "after_turn_commit"],
    capturePoints: ["tool calls", "prompt", "history export"],
    injectionPoints: ["MCP tool replies", "wrapper-prepended memory"],
    notes: ["MCP is primary; wrapper is the practical fallback."],
  },
  {
    agentKind: "kilo-code",
    displayName: "Kilo Code",
    category: "editor",
    recommendedMode: "mcp",
    defaultSignals: { hasMcp: true, canReadLogs: true },
    recommendedHooks: ["mcp.memory_search", "mcp.memory_get", "history.export"],
    capturePoints: ["MCP activity", "session logs", "workspace edits"],
    injectionPoints: ["MCP memory tools", "history replay"],
    notes: ["Tool-level integration is enough for consistent recall."],
  },
  {
    agentKind: "aider",
    displayName: "Aider",
    category: "cli",
    recommendedMode: "rest-sdk",
    defaultSignals: { hasHttpApi: true, canReadLogs: true },
    recommendedHooks: ["rest.memory_search", "rest.memory_get", "rest.history_ingest"],
    capturePoints: ["REST requests", "git diff", "session logs"],
    injectionPoints: ["HTTP recall endpoint", "summary response"],
    notes: ["REST is the cleanest integration path for Aider-style clients."],
  },
  {
    agentKind: "claude-desktop",
    displayName: "Claude Desktop",
    category: "desktop",
    recommendedMode: "mcp",
    defaultSignals: { hasMcp: true, hasHttpApi: true },
    recommendedHooks: ["mcp.memory_search", "mcp.memory_get", "mcp.memory_timeline"],
    capturePoints: ["tool requests", "conversation state", "exported history"],
    injectionPoints: ["MCP tool results", "client-side session memory"],
    notes: ["Desktop clients usually prefer standard MCP transport."],
  },
  {
    agentKind: "windsurf",
    displayName: "Windsurf",
    category: "editor",
    recommendedMode: "mcp",
    defaultSignals: { hasMcp: true, hasLifecycleHooks: true },
    recommendedHooks: ["before_prompt_build", "mcp.memory_search", "after_turn_commit"],
    capturePoints: ["prompt build", "tool traffic", "turn end"],
    injectionPoints: ["prompt hints", "MCP response"],
    notes: ["Hybrid hook + MCP support is the best fit."],
  },
  {
    agentKind: "roo-code",
    displayName: "Roo Code",
    category: "editor",
    recommendedMode: "mcp",
    defaultSignals: { hasMcp: true, canWrapProcess: true },
    recommendedHooks: ["mcp.memory_search", "before_prompt_build", "after_turn_commit"],
    capturePoints: ["chat turn", "tool calls", "workspace output"],
    injectionPoints: ["MCP memory tool", "wrapper context"],
    notes: ["Keep the first implementation at the MCP layer."],
  },
  {
    agentKind: "nanobot",
    displayName: "NanoBot",
    category: "custom",
    recommendedMode: "historical-connector",
    defaultSignals: { hasHistoryExport: true, canReadLogs: true },
    recommendedHooks: ["history.export", "audit.log.ingest", "offline.memory.mine"],
    capturePoints: ["exported session logs", "artifact snapshots", "command traces"],
    injectionPoints: ["post-hoc memory mining", "retrospective skill promotion"],
    notes: ["Treat as a history-first or closed-system integration unless native hooks are exposed."],
  },
];

const MODE_LEVEL: Record<IntegrationMode, CompatibilityLevel> = {
  "native-integration": "l5",
  "hook-plugin": "l4",
  mcp: "l3",
  "rest-sdk": "l2",
  "wrapper-proxy": "l1",
  "historical-connector": "l0",
};

const MODE_SUPPORT: Record<IntegrationMode, Record<CapabilityPoint, CapabilitySupport>> = {
  "native-integration": {
    "session.start": "strong",
    "turn.prepare": "strong",
    "tool.observe": "strong",
    "tool.rewrite": "medium",
    "turn.complete": "strong",
    "subagent.prepare": "strong",
    "subagent.complete": "strong",
    "feedback.record": "strong",
    "history.ingest": "medium",
    "history.mine": "medium",
    "memory.promote": "medium",
  },
  "hook-plugin": {
    "session.start": "strong",
    "turn.prepare": "strong",
    "tool.observe": "strong",
    "tool.rewrite": "medium",
    "turn.complete": "strong",
    "subagent.prepare": "medium",
    "subagent.complete": "medium",
    "feedback.record": "medium",
    "history.ingest": "medium",
    "history.mine": "weak",
    "memory.promote": "weak",
  },
  mcp: {
    "session.start": "weak",
    "turn.prepare": "medium",
    "tool.observe": "medium",
    "tool.rewrite": "weak",
    "turn.complete": "medium",
    "subagent.prepare": "weak",
    "subagent.complete": "weak",
    "feedback.record": "medium",
    "history.ingest": "weak",
    "history.mine": "weak",
    "memory.promote": "weak",
  },
  "rest-sdk": {
    "session.start": "medium",
    "turn.prepare": "medium",
    "tool.observe": "medium",
    "tool.rewrite": "weak",
    "turn.complete": "medium",
    "subagent.prepare": "medium",
    "subagent.complete": "medium",
    "feedback.record": "strong",
    "history.ingest": "strong",
    "history.mine": "medium",
    "memory.promote": "weak",
  },
  "wrapper-proxy": {
    "session.start": "medium",
    "turn.prepare": "medium",
    "tool.observe": "weak",
    "tool.rewrite": "medium",
    "turn.complete": "medium",
    "subagent.prepare": "weak",
    "subagent.complete": "weak",
    "feedback.record": "medium",
    "history.ingest": "medium",
    "history.mine": "weak",
    "memory.promote": "weak",
  },
  "historical-connector": {
    "session.start": "n/a",
    "turn.prepare": "n/a",
    "tool.observe": "n/a",
    "tool.rewrite": "n/a",
    "turn.complete": "n/a",
    "subagent.prepare": "n/a",
    "subagent.complete": "n/a",
    "feedback.record": "medium",
    "history.ingest": "strong",
    "history.mine": "strong",
    "memory.promote": "medium",
  },
};

export function assessCompatibility(input: CompatibilityAssessmentInput): CompatibilityAssessment {
  const profile = getAgentProfile(input.agentKind);
  const signals = normalizeSignals({
    ...profile?.defaultSignals,
    ...input.signals,
  });
  const mode = resolveMode(input.preferredMode, profile, signals);
  const level = mode ? MODE_LEVEL[mode] : "l-1";
  const coverage = mode ? { ...MODE_SUPPORT[mode] } : buildIncompatibleCoverage();
  const compatible = mode !== null;
  const agentKind = profile?.agentKind ?? normalizeAgentKind(input.agentKind) ?? "unknown";

  return {
    agentKind,
    displayName: profile?.displayName ?? input.agentKind?.trim() ?? "Unknown Agent",
    mode,
    level,
    compatible,
    signals,
    coverage,
    canAutoInject: coverage["turn.prepare"] === "strong" || coverage["turn.prepare"] === "medium",
    canAutoCapture: coverage["tool.observe"] === "strong" || coverage["turn.complete"] === "strong" || coverage["turn.complete"] === "medium",
    canMineHistory: coverage["history.ingest"] === "strong" || coverage["history.mine"] === "strong",
    recommendedNextStep: recommendNextStep(mode, profile, signals),
    notes: [...(profile?.notes ?? []), ...(input.notes ?? [])],
  };
}

export function buildIntegrationPlan(input: CompatibilityAssessmentInput): AgentIntegrationPlan {
  const assessment = assessCompatibility(input);
  const profile = getAgentProfile(assessment.agentKind);
  return {
    ...assessment,
    profile,
    recommendedHooks: profile?.recommendedHooks ?? defaultHooksForMode(assessment.mode),
    capturePoints: profile?.capturePoints ?? defaultCapturePointsForMode(assessment.mode),
    injectionPoints: profile?.injectionPoints ?? defaultInjectionPointsForMode(assessment.mode),
    rolloutOrder: rolloutOrderFor(assessment.mode),
  };
}

export function listCompatibilityCapabilities(): readonly CapabilityPoint[] {
  return CAPABILITY_POINTS;
}

export function listAgentProfiles(): readonly AgentProfile[] {
  return AGENT_PROFILES;
}

export function getAgentProfile(agentKind?: string | null): AgentProfile | null {
  const normalized = normalizeAgentKind(agentKind);
  if (!normalized) return null;
  return AGENT_PROFILES.find((profile) => normalizeAgentKind(profile.agentKind) === normalized) ?? null;
}

export function supportMatrixFor(mode: IntegrationMode | null): Record<CapabilityPoint, CapabilitySupport> {
  if (!mode) return buildIncompatibleCoverage();
  return { ...MODE_SUPPORT[mode] };
}

function normalizeSignals(input: CompatibilitySignals): Required<CompatibilitySignals> {
  return {
    hasAgentLoop: !!input.hasAgentLoop,
    hasMemoryProvider: !!input.hasMemoryProvider,
    hasLifecycleHooks: !!input.hasLifecycleHooks,
    hasMcp: !!input.hasMcp,
    hasHttpApi: !!input.hasHttpApi,
    canWrapProcess: !!input.canWrapProcess,
    canProxyProvider: !!input.canProxyProvider,
    hasHistoryExport: !!input.hasHistoryExport,
    canReadLogs: !!input.canReadLogs,
    canRewritePrompt: !!input.canRewritePrompt,
  };
}

function resolveMode(
  preferredMode: IntegrationMode | null | undefined,
  profile: AgentProfile | null,
  signals: Required<CompatibilitySignals>,
): IntegrationMode | null {
  if (preferredMode) return preferredMode;
  if (signals.hasAgentLoop || signals.hasMemoryProvider) return "native-integration";
  if (signals.hasLifecycleHooks) return "hook-plugin";
  if (signals.hasMcp) return "mcp";
  if (signals.hasHttpApi) return "rest-sdk";
  if (signals.canWrapProcess || signals.canProxyProvider) return "wrapper-proxy";
  if (signals.hasHistoryExport || signals.canReadLogs) return "historical-connector";
  return profile?.recommendedMode ?? null;
}

function recommendNextStep(
  mode: IntegrationMode | null,
  profile: AgentProfile | null,
  signals: Required<CompatibilitySignals>,
): string {
  if (mode === "native-integration") {
    return "Map host loop events to session, turn, tool, and feedback APIs.";
  }
  if (mode === "hook-plugin") {
    return "Register lifecycle hooks and forward prompt/tool events to the memory service.";
  }
  if (mode === "mcp") {
    return "Expose a compact MCP surface with recall/capture/feedback tools.";
  }
  if (mode === "rest-sdk") {
    return "Wrap the host with the REST/SDK API and call the MemOS service directly.";
  }
  if (mode === "wrapper-proxy") {
    return "Use a wrapper or provider proxy to inject context before run and capture results after run.";
  }
  if (mode === "historical-connector") {
    return "Implement a historical ingestion job that mines exported logs and promotes stable patterns.";
  }
  if (profile) {
    return `Follow ${profile.displayName}'s recommended mode: ${profile.recommendedMode}.`;
  }
  if (signals.hasHistoryExport || signals.canReadLogs) {
    return "Only history data is available; use the historical connector path.";
  }
  return "No supported open surface detected; integration is not promised.";
}

function defaultHooksForMode(mode: IntegrationMode | null): string[] {
  switch (mode) {
    case "native-integration":
      return ["agent_turn_prepare", "tool_result_record", "after_turn_commit"];
    case "hook-plugin":
      return ["before_prompt_build", "after_tool_result", "after_turn_commit"];
    case "mcp":
      return ["mcp.memory_search", "mcp.memory_get", "mcp.memory_write"];
    case "rest-sdk":
      return ["rest.memory_search", "rest.memory_ingest", "rest.memory_get"];
    case "wrapper-proxy":
      return ["proxy.before_call", "proxy.after_call", "proxy.after_turn"];
    case "historical-connector":
      return ["history.export", "audit.log.ingest", "offline.memory.mine"];
    default:
      return [];
  }
}

function defaultCapturePointsForMode(mode: IntegrationMode | null): string[] {
  switch (mode) {
    case "native-integration":
      return ["loop event", "tool result", "turn complete", "subagent outcome"];
    case "hook-plugin":
      return ["prompt build", "tool result", "turn complete"];
    case "mcp":
      return ["MCP tool calls", "turn completion"];
    case "rest-sdk":
      return ["HTTP request", "HTTP response", "session export"];
    case "wrapper-proxy":
      return ["proxy request", "proxy response", "process stderr/stdout"];
    case "historical-connector":
      return ["history export", "logs", "session snapshots"];
    default:
      return [];
  }
}

function defaultInjectionPointsForMode(mode: IntegrationMode | null): string[] {
  switch (mode) {
    case "native-integration":
      return ["system-adjacent prompt", "developer note", "tool hint"];
    case "hook-plugin":
      return ["prompt prefix", "developer block", "memory sidecar"];
    case "mcp":
      return ["MCP tool output", "tool-triggered recall"];
    case "rest-sdk":
      return ["SDK response", "server-side recall"];
    case "wrapper-proxy":
      return ["proxy-prepended context", "proxy tool result"];
    case "historical-connector":
      return ["offline mining result", "promoted memory asset"];
    default:
      return [];
  }
}

function rolloutOrderFor(mode: IntegrationMode | null): string[] {
  switch (mode) {
    case "native-integration":
      return ["capture loop", "capture tools", "inject memory", "promote skills"];
    case "hook-plugin":
      return ["install hooks", "capture prompt", "capture tool results", "inject memory"];
    case "mcp":
      return ["publish MCP tools", "wire search/get", "capture tool outputs"];
    case "rest-sdk":
      return ["ship REST client", "wire ingest/search", "add offline export"];
    case "wrapper-proxy":
      return ["wrap host process", "tap stdout/stderr", "replay prompt context"];
    case "historical-connector":
      return ["ingest exports", "mine sessions", "promote patterns"];
    default:
      return [];
  }
}

function buildIncompatibleCoverage(): Record<CapabilityPoint, CapabilitySupport> {
  return {
    "session.start": "n/a",
    "turn.prepare": "n/a",
    "tool.observe": "n/a",
    "tool.rewrite": "n/a",
    "turn.complete": "n/a",
    "subagent.prepare": "n/a",
    "subagent.complete": "n/a",
    "feedback.record": "n/a",
    "history.ingest": "n/a",
    "history.mine": "n/a",
    "memory.promote": "n/a",
  };
}

function normalizeAgentKind(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
