import type { CoreHealth } from "../../agent-contract/memory-core.js";

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

export function assertCompatibleOpenClawRuntime(
  health: Pick<CoreHealth, "runtime"> | Record<string, unknown>,
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
