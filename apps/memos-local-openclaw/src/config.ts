import * as path from "path";
import { DEFAULTS, type MemosLocalConfig, type PluginContext, type Logger } from "./types";

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

export function resolveConfig(raw: Partial<MemosLocalConfig> | undefined, stateDir: string): MemosLocalConfig {
  const cfg = deepResolveEnv(raw ?? {});

  const telemetryEnvVar = process.env.TELEMETRY_ENABLED;
  const telemetryEnabled =
    cfg.telemetry?.enabled ??
    (telemetryEnvVar === "false" || telemetryEnvVar === "0" ? false : true);

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
      posthogApiKey: cfg.telemetry?.posthogApiKey ?? process.env.POSTHOG_API_KEY ?? "",
      posthogHost: cfg.telemetry?.posthogHost ?? process.env.POSTHOG_HOST ?? "",
    },
  };
}

export function getOpenClawHome(stateDir?: string): string {
  if (stateDir && stateDir.trim().length > 0) return stateDir;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".openclaw");
}

export function getOpenClawConfigPath(stateDir?: string): string {
  return path.join(getOpenClawHome(stateDir), "openclaw.json");
}

export function buildContext(
  stateDir: string,
  workspaceDir: string,
  rawConfig: Partial<MemosLocalConfig> | undefined,
  log?: Logger,
): PluginContext {
  const defaultLog: Logger = {
    debug: (...args) => console.debug("[memos-local]", ...args),
    info: (...args) => console.info("[memos-local]", ...args),
    warn: (...args) => console.warn("[memos-local]", ...args),
    error: (...args) => console.error("[memos-local]", ...args),
  };

  return {
    stateDir,
    workspaceDir,
    config: resolveConfig(rawConfig, stateDir),
    log: log ?? defaultLog,
  };
}
