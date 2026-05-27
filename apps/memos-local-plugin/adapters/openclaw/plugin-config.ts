export interface OpenClawPluginFeatureConfig {
  memorySearchEnabled: boolean;
  memoryAddEnabled: boolean;
}

export const OPENCLAW_PLUGIN_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: true,
  description: "MemOS Local OpenClaw runtime switches.",
  properties: {
    memory_search: {
      type: "object",
      additionalProperties: true,
      description: "Control whether MemOS Local exposes and performs memory_search.",
      properties: {
        enabled: {
          type: "boolean",
          default: true,
          description: "Enable memory_search tool registration and automatic turn-start retrieval.",
        },
      },
    },
    memory_add: {
      type: "object",
      additionalProperties: true,
      description: "Control whether MemOS Local writes conversation turns into memory.",
      properties: {
        enabled: {
          type: "boolean",
          default: true,
          description: "Enable memory_add capture on agent_end.",
        },
      },
    },
  },
} as const;

export function resolveOpenClawPluginConfig(
  raw: Record<string, unknown> | undefined,
): OpenClawPluginFeatureConfig {
  return {
    memorySearchEnabled: resolveEnabled(raw, "memory_search", "memorySearchEnabled"),
    memoryAddEnabled: resolveEnabled(raw, "memory_add", "memoryAddEnabled"),
  };
}

function resolveEnabled(
  raw: Record<string, unknown> | undefined,
  objectKey: string,
  legacyBoolKey: string,
): boolean {
  if (!raw) return true;

  const direct = raw[objectKey];
  if (typeof direct === "boolean") return direct;
  if (isRecord(direct) && typeof direct.enabled === "boolean") {
    return direct.enabled;
  }

  const legacy = raw[legacyBoolKey];
  if (typeof legacy === "boolean") return legacy;

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
