import * as path from "path";
import { DEFAULTS, type MemosLocalConfig, type PluginContext, type Logger, type EmbeddingConfig, type SummarizerConfig } from "./types";
import { OpenClawAPIClient, type HostModelsConfig } from "./openclaw-api";

const ENV_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function resolveEnvVars(value: string): string {
  return value.replace(ENV_RE, (_, name) => process.env[name] ?? "");
}

function deepResolveEnv<T>(obj: T): T {
  if (typeof obj === "string") return resolveEnvVars(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map(deepResolveEnv) as unknown as T;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = deepResolveEnv(v);
    }
    return out as T;
  }
  return obj;
}

function resolveProviderFallback<T extends { provider?: string; capabilities?: unknown }>(
  config: T | undefined,
  fallbackProvider: T["provider"],
  enabled: boolean,
): T | undefined {
  if (!config) {
    return enabled
      ? ({ provider: fallbackProvider } as T)
      : undefined;
  }

  if (config.provider == null && enabled) {
    return { ...config, provider: fallbackProvider };
  }

  return config;
}

export function resolveConfig(raw: Partial<MemosLocalConfig> | undefined, stateDir: string): MemosLocalConfig {
  const cfg = deepResolveEnv(raw ?? {});

  const telemetryEnvVar = process.env.TELEMETRY_ENABLED;
  const telemetryEnabled =
    cfg.telemetry?.enabled ??
    (telemetryEnvVar === "false" || telemetryEnvVar === "0" ? false : true);
  const sharingCapabilities = {
    hostEmbedding: cfg.sharing?.capabilities?.hostEmbedding ?? false,
    hostCompletion: cfg.sharing?.capabilities?.hostCompletion ?? false,
    hostSkill: cfg.sharing?.capabilities?.hostSkill ?? false,
  };

  return {
    ...cfg,
    storage: {
      dbPath: cfg.storage?.dbPath ?? path.join(stateDir, "memos-local", "memos.db"),
    },
    recall: {
      maxResultsDefault: cfg.recall?.maxResultsDefault ?? DEFAULTS.maxResultsDefault,
      maxResultsMax: cfg.recall?.maxResultsMax ?? DEFAULTS.maxResultsMax,
      minScoreDefault: cfg.recall?.minScoreDefault ?? DEFAULTS.minScoreDefault,
      minScoreFloor: cfg.recall?.minScoreFloor ?? DEFAULTS.minScoreFloor,
      rrfK: cfg.recall?.rrfK ?? DEFAULTS.rrfK,
      mmrLambda: cfg.recall?.mmrLambda ?? DEFAULTS.mmrLambda,
      recencyHalfLifeDays: cfg.recall?.recencyHalfLifeDays ?? DEFAULTS.recencyHalfLifeDays,
      vectorSearchMaxChunks: cfg.recall?.vectorSearchMaxChunks ?? DEFAULTS.vectorSearchMaxChunks,
    },
    dedup: {
      similarityThreshold: cfg.dedup?.similarityThreshold ?? DEFAULTS.dedupSimilarityThreshold,
    },
    capture: {
      evidenceWrapperTag: cfg.capture?.evidenceWrapperTag ?? DEFAULTS.evidenceWrapperTag,
    },
    telemetry: {
      enabled: telemetryEnabled,
    },
    summarizer: (() => {
      const summarizerConfig = resolveProviderFallback<SummarizerConfig>(
        cfg.summarizer,
        "openclaw",
        sharingCapabilities.hostCompletion,
      );
      return summarizerConfig
        ? {
            ...summarizerConfig,
            capabilities: sharingCapabilities,
          }
        : undefined;
    })(),
    embedding: (() => {
      const embeddingConfig = resolveProviderFallback<EmbeddingConfig>(
        cfg.embedding,
        "openclaw",
        sharingCapabilities.hostEmbedding,
      );
      return embeddingConfig
        ? {
            ...embeddingConfig,
            capabilities: sharingCapabilities,
          }
        : undefined;
    })(),
    skillEvolution: cfg.skillEvolution ? {
      ...cfg.skillEvolution,
      summarizer: (() => {
        const skSumCfg = resolveProviderFallback<SummarizerConfig>(
          cfg.skillEvolution!.summarizer as SummarizerConfig | undefined,
          "openclaw",
          sharingCapabilities.hostSkill,
        );
        return skSumCfg
          ? { ...skSumCfg, capabilities: sharingCapabilities }
          : undefined;
      })(),
    } : undefined,
    sharing: (() => {
      const role = cfg.sharing?.role ?? "client";
      const enabled = cfg.sharing?.enabled ?? false;
      const hub = role === "hub" ? {
        port: cfg.sharing?.hub?.port ?? 18800,
        teamName: cfg.sharing?.hub?.teamName ?? "",
        teamToken: cfg.sharing?.hub?.teamToken ?? "",
      } : { port: 18800, teamName: "", teamToken: "" };
      const client = role === "client" ? {
        hubAddress: cfg.sharing?.client?.hubAddress ?? "",
        userToken: cfg.sharing?.client?.userToken ?? "",
        teamToken: cfg.sharing?.client?.teamToken ?? "",
        pendingUserId: cfg.sharing?.client?.pendingUserId ?? "",
        nickname: cfg.sharing?.client?.nickname ?? "",
      } : { hubAddress: "", userToken: "", teamToken: "", pendingUserId: "", nickname: "" };
      return { enabled, role, hub, client, capabilities: sharingCapabilities };
    })(),
  };
}

export function buildContext(
  stateDir: string,
  workspaceDir: string,
  rawConfig: Partial<MemosLocalConfig> | undefined,
  log?: Logger,
  hostModels?: HostModelsConfig,
): PluginContext {
  const defaultLog: Logger = {
    debug: (...args) => console.debug("[memos-local]", ...args),
    info: (...args) => console.info("[memos-local]", ...args),
    warn: (...args) => console.warn("[memos-local]", ...args),
    error: (...args) => console.error("[memos-local]", ...args),
  };

  const logger = log ?? defaultLog;
  const config = resolveConfig(rawConfig, stateDir);

  // Create OpenClawAPI instance if host capabilities are enabled
  const openclawAPI = (config.sharing?.capabilities?.hostEmbedding || config.sharing?.capabilities?.hostCompletion || config.sharing?.capabilities?.hostSkill)
    ? new OpenClawAPIClient(logger, hostModels)
    : undefined;

  return {
    stateDir,
    workspaceDir,
    config,
    log: logger,
    openclawAPI,
  };
}
