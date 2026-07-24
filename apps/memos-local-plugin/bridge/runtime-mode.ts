import type { AgentKind } from "../agent-contract/dto.js";

export interface BridgeRuntimeMode {
  hostLlmEnabled: boolean;
  evolutionWorkerEnabled: boolean;
}

/**
 * Shared policy for both bridge.mts (the preferred ESM entry) and the
 * bridge.cts compatibility entry. A Hermes viewer daemon has no reverse
 * stdio channel, so it must preserve durable jobs for the next Hermes
 * stdio session instead of attempting host-LLM evolution itself.
 */
export function resolveBridgeRuntimeMode(input: {
  agent: AgentKind;
  daemon: boolean;
}): BridgeRuntimeMode {
  const hostLlmEnabled = !input.daemon;
  return {
    hostLlmEnabled,
    evolutionWorkerEnabled:
      !(input.agent === "hermes" && input.daemon),
  };
}
