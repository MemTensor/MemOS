import type { CoreHealth } from "../../agent-contract/memory-core.js";
import type { AgentKind } from "../../agent-contract/dto.js";
import type { OpenClawRuntimeLockOwner } from "./runtime-lock.js";

const REQUIRED_CAPABILITIES = [
  "openclaw.shared-runtime.v1",
  "openclaw.tool-outcome.v1",
  "openclaw.durable-evolution.v1",
  "openclaw.drain-status.v1",
  "openclaw.safe-reconnect.v1",
] as const;

export const OPENCLAW_RUNTIME_PROTOCOL = {
  major: 1,
  minor: 0,
  requiredCapabilities: REQUIRED_CAPABILITIES,
} as const;

export interface OpenClawRuntimeHealth {
  protocolMajor: number;
  protocolMinor: number;
  pluginVersion: string;
  capabilities: string[];
}

export interface SharedRuntimeHealth extends OpenClawRuntimeHealth {
  agent: AgentKind;
  runtimeMode: "shared-ipc";
  multiProcess: true;
}

export class IncompatibleOpenClawRuntimeError extends Error {
  readonly code = "incompatible_runtime";

  constructor(message: string) {
    super(message);
    this.name = "IncompatibleOpenClawRuntimeError";
  }
}

export class RuntimeWriteOutcomeUnknownError extends Error {
  readonly code = "rpc_write_outcome_unknown";
  readonly method: string;

  constructor(method: string, cause: unknown) {
    super(
      `MemOS RPC ${method} lost its transport before a response was received; ` +
        "the write was not replayed because its outcome is unknown",
      { cause },
    );
    this.name = "RuntimeWriteOutcomeUnknownError";
    this.method = method;
  }
}

export function openClawRuntimeHealth(pluginVersion: string): OpenClawRuntimeHealth {
  return {
    protocolMajor: OPENCLAW_RUNTIME_PROTOCOL.major,
    protocolMinor: OPENCLAW_RUNTIME_PROTOCOL.minor,
    pluginVersion,
    capabilities: [...OPENCLAW_RUNTIME_PROTOCOL.requiredCapabilities],
  };
}

export function sharedRuntimeHealth(
  agent: AgentKind,
  pluginVersion: string,
): SharedRuntimeHealth {
  const capabilities = new Set<string>(REQUIRED_CAPABILITIES);
  capabilities.delete("openclaw.shared-runtime.v1");
  capabilities.add(`${agent}.shared-runtime.v1`);
  if (agent === "hermes") capabilities.add("hermes.turn-end-idempotency.v1");
  return {
    protocolMajor: OPENCLAW_RUNTIME_PROTOCOL.major,
    protocolMinor: OPENCLAW_RUNTIME_PROTOCOL.minor,
    pluginVersion,
    capabilities: [...capabilities],
    agent,
    runtimeMode: "shared-ipc",
    multiProcess: true,
  };
}

export function assertCompatibleSharedRuntime(
  health: Pick<CoreHealth, "runtime" | "agent"> | Record<string, unknown>,
  options: {
    expectedAgent: AgentKind;
    expectedPluginVersion?: string;
  },
): asserts health is Pick<CoreHealth, "runtime" | "agent"> {
  const runtime = health.runtime;
  if (!runtime || typeof runtime !== "object") {
    throw new IncompatibleOpenClawRuntimeError(
      "MemOS shared runtime does not advertise a protocol version",
    );
  }
  const candidate = runtime as Partial<SharedRuntimeHealth>;
  if (candidate.protocolMajor !== OPENCLAW_RUNTIME_PROTOCOL.major) {
    throw new IncompatibleOpenClawRuntimeError(
      `MemOS runtime protocol major ${String(candidate.protocolMajor)} is incompatible with ` +
        `client major ${OPENCLAW_RUNTIME_PROTOCOL.major}`,
    );
  }
  if (
    options.expectedPluginVersion !== undefined &&
    candidate.pluginVersion !== options.expectedPluginVersion
  ) {
    throw new IncompatibleOpenClawRuntimeError(
      `MemOS runtime plugin version ${String(candidate.pluginVersion)} does not match ` +
        `client plugin version ${options.expectedPluginVersion}`,
    );
  }
  const runtimeAgent = candidate.agent ?? health.agent;
  if (runtimeAgent !== options.expectedAgent) {
    throw new IncompatibleOpenClawRuntimeError(
      `MemOS runtime agent ${String(runtimeAgent)} does not match client agent ` +
        options.expectedAgent,
    );
  }
  if (candidate.runtimeMode !== "shared-ipc" || candidate.multiProcess !== true) {
    throw new IncompatibleOpenClawRuntimeError(
      "MemOS runtime does not advertise multi-process shared IPC support",
    );
  }
  const capabilities = new Set(
    Array.isArray(candidate.capabilities)
      ? candidate.capabilities.filter((value): value is string => typeof value === "string")
      : [],
  );
  const required = [
    `${options.expectedAgent}.shared-runtime.v1`,
    "openclaw.durable-evolution.v1",
    "openclaw.drain-status.v1",
    "openclaw.safe-reconnect.v1",
  ];
  const missing = required.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) {
    throw new IncompatibleOpenClawRuntimeError(
      `MemOS runtime is missing required capabilities: ${missing.join(", ")}`,
    );
  }
}

export function assertCompatibleOpenClawRuntime(
  health: Pick<CoreHealth, "runtime"> | Record<string, unknown>,
  options: { expectedPluginVersion?: string } = {},
): asserts health is Pick<CoreHealth, "runtime"> {
  const runtime = health.runtime;
  if (!runtime || typeof runtime !== "object") {
    throw new IncompatibleOpenClawRuntimeError(
      "MemOS shared runtime does not advertise a protocol version; " +
        "stop the legacy daemon before starting this plugin",
    );
  }
  const candidate = runtime as Partial<OpenClawRuntimeHealth>;
  if (candidate.protocolMajor !== OPENCLAW_RUNTIME_PROTOCOL.major) {
    throw new IncompatibleOpenClawRuntimeError(
      `MemOS runtime protocol major ${String(candidate.protocolMajor)} is incompatible with ` +
        `client major ${OPENCLAW_RUNTIME_PROTOCOL.major}`,
    );
  }
  if (
    options.expectedPluginVersion !== undefined &&
    candidate.pluginVersion !== options.expectedPluginVersion
  ) {
    throw new IncompatibleOpenClawRuntimeError(
      `MemOS runtime plugin version ${String(candidate.pluginVersion)} does not match ` +
        `client plugin version ${options.expectedPluginVersion}; restart the OpenClaw gateway`,
    );
  }
  const capabilities = new Set(
    Array.isArray(candidate.capabilities)
      ? candidate.capabilities.filter((value): value is string => typeof value === "string")
      : [],
  );
  const missing = OPENCLAW_RUNTIME_PROTOCOL.requiredCapabilities.filter(
    (capability) => !capabilities.has(capability),
  );
  if (missing.length > 0) {
    throw new IncompatibleOpenClawRuntimeError(
      `MemOS runtime is missing required capabilities: ${missing.join(", ")}`,
    );
  }
}

export function assertCompatibleOpenClawRuntimeOwner(
  owner: Pick<OpenClawRuntimeLockOwner, "agent" | "protocolMajor" | "version"> | null,
  options: { expectedPluginVersion?: string; expectedAgent?: AgentKind } = {},
): void {
  if (owner?.protocolMajor === undefined) {
    throw new IncompatibleOpenClawRuntimeError(
      "A live legacy MemOS OpenClaw owner holds the runtime lock without a " +
        "shared-runtime protocol marker; stop the old gateway before upgrading",
    );
  }
  if (owner.protocolMajor !== OPENCLAW_RUNTIME_PROTOCOL.major) {
    throw new IncompatibleOpenClawRuntimeError(
      `MemOS lock owner protocol major ${owner.protocolMajor} is incompatible with ` +
        `client major ${OPENCLAW_RUNTIME_PROTOCOL.major}`,
    );
  }
  if (
    options.expectedAgent !== undefined &&
    (owner.agent ?? "openclaw") !== options.expectedAgent
  ) {
    throw new IncompatibleOpenClawRuntimeError(
      `MemOS lock owner agent ${String(owner.agent ?? "openclaw")} does not match ` +
        `client agent ${options.expectedAgent}`,
    );
  }
  if (
    options.expectedPluginVersion !== undefined &&
    owner.version !== options.expectedPluginVersion
  ) {
    throw new IncompatibleOpenClawRuntimeError(
      `MemOS lock owner plugin version ${owner.version} does not match ` +
        `client plugin version ${options.expectedPluginVersion}; restart the OpenClaw gateway`,
    );
  }
}

const REPLAY_SAFE_METHODS = new Set<string>([
  "core.health",
  "memory.search",
  "memory.get_trace",
  "memory.get_policy",
  "memory.get_world",
  "memory.list_episodes",
  "memory.timeline",
  "memory.list_traces",
  "memory.list_world_models",
  "skill.list",
]);

export function isReplaySafeOpenClawRuntimeMethod(method: string): boolean {
  return REPLAY_SAFE_METHODS.has(method);
}
