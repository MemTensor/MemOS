/**
 * Public entry point for `core/config/`.
 *
 *   loadConfig(home)  → reads home.configFile, deep-merges over defaults,
 *                       validates with the schema, returns a frozen object.
 *   resolveConfig(raw)→ same merge + validate, but starting from an arbitrary
 *                       raw object (used by adapters that build config in code).
 *
 * Anything that needs to *write* config goes through `writer.ts`.
 */

import { promises as fs } from "node:fs";

import { Type } from "@sinclair/typebox";
import { Value, type ValueError } from "@sinclair/typebox/value";

import { MemosError } from "../../agent-contract/errors.js";
import type { ResolvedHome } from "./paths.js";
import { resolveHome } from "./paths.js";
import { ConfigSchema, type ResolvedConfig } from "./schema.js";
import {
  DEFAULT_CONFIG,
  FREE_FORM_CONFIG_PATHS,
  SECRET_FIELD_PATHS,
  effectiveViewerPort,
} from "./defaults.js";
import { migrateHermesViewerPort } from "./migrations.js";
import { parseYaml } from "./yaml.js";

export type { ResolvedConfig } from "./schema.js";
export type { ResolvedHome } from "./paths.js";
export { resolveHome } from "./paths.js";
export { DEFAULT_CONFIG, SECRET_FIELD_PATHS } from "./defaults.js";

export interface LoadConfigResult {
  config: ResolvedConfig;
  /** Whether the config file existed; when false, defaults are returned. */
  fromDisk: boolean;
  /** Validation warnings (extra unknown keys, removed fields, …). */
  warnings: string[];
  /** Path that was read (or the path we *would* read on next save). */
  source: string;
}

export async function loadConfig(home: ResolvedHome, agent?: string): Promise<LoadConfigResult> {
  let raw: unknown = {};
  let fromDisk = false;
  const warnings: string[] = [];

  if (agent === "hermes") await migrateHermesViewerPort(home);

  try {
    const text = await fs.readFile(home.configFile, "utf8");
    raw = parseYaml(text, home.configFile);
    fromDisk = true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      warnings.push(
        `config file not found at ${home.configFile}; using defaults. ` +
        `To fix: set MEMOS_HOME or MEMOS_CONFIG_FILE env var, or use --home CLI flag. ` +
        `See: https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin#configuration`
      );
    } else if (MemosError.is(err)) {
      throw err;
    } else {
      throw new MemosError("config_invalid", `cannot read ${home.configFile}: ${e.message}`, {
        source: home.configFile,
      });
    }
  }

  // `maxInputTokens` was introduced with a disabled (`0`) fallback. Keep
  // that behaviour for an existing on-disk config that predates the field,
  // while config-less/new installations receive the safer 1024 default.
  if (fromDisk) raw = withLegacyEmbeddingInputLimit(raw);

  const config = resolveConfig(raw, warnings, agent);
  return { config, fromDisk, warnings, source: home.configFile };
}

/**
 * Merge an arbitrary raw object over `DEFAULT_CONFIG` and validate. Used in
 * tests and by `writer.ts`. `warnings` is mutated in place if provided.
 *
 * The `raw` argument is never mutated — the secret resolution below runs on a
 * freshly built copy, so callers may pass shared or cached objects safely.
 */
export function resolveConfig(raw: unknown, warnings?: string[], agent?: string): ResolvedConfig {
  const cleaned = pruneUnknown(raw, DEFAULT_CONFIG, "", warnings);
  // Resolve masked/placeholder secret values from the environment before
  // merging. `maskSecrets()` (pipeline/memory-core.ts) rewrites every
  // SECRET_FIELD_PATHS leaf to `__memos_secret__` before the config is
  // persisted or surfaced, and `stripEmptySecrets()` drops empty leaves
  // from patches. But nothing re-reads the real value back: when the
  // daemon restarts and `loadConfig()` parses the YAML, the placeholder
  // is treated as the literal API key, so every LLM call fails auth and
  // the bridge loops on restart with `lastOkAt: null` and crystallize
  // stuck. Same problem if a user writes `apiKey: ""` or an explicit
  // `${ENV_VAR}` reference and expects expansion (the writer's
  // `resolveConfig` is the single choke point for both disk and
  // in-memory patch paths, so resolving here covers both).
  //
  // Resolution rules (first match wins):
  //   1. Value is `${NAME}`  -> use process.env[NAME]. Only allowlisted
  //      names are expanded (`^[A-Z][A-Z0-9_]*_(API_KEY|TOKEN)$`);
  //      anything else emits a warning and is left untouched.
  //   2. Value is the mask sentinel `__memos_secret__` or empty string
  //      -> derive the env var from the field path itself
  //      (llm.apiKey -> LLM_API_KEY, hub.teamToken -> HUB_TEAM_TOKEN,
  //      skillEvolver.apiKey -> SKILL_EVOLVER_API_KEY, …). Provider-specific
  //      OpenCode fallbacks only apply when the primary LLM points at the
  //      matching opencode.ai endpoint; unrelated providers and dedicated
  //      config slots never borrow those keys.
  //   3. Otherwise leave the value untouched.
  //
  // A masked sentinel or explicit env reference with no backing variable
  // emits a warning. A plain empty string does not: empty keys are valid for
  // local/host providers and disabled optional integrations.
  //
  // The mask itself is never used as a credential, and the on-disk write
  // stays masked (security preserved); this is read-side only.
  resolveSecretEnv(cleaned, warnings);
  const merged = deepMerge(DEFAULT_CONFIG as Record<string, unknown>, cleaned);
  stripUnsupportedEmbeddingDimensions(merged);
  const viewerPort = effectiveViewerPort(agent);
  if (viewerPort !== undefined && isPlainObject(merged.viewer)) {
    merged.viewer.port = viewerPort;
  }

  // Apply Typebox defaults + coerce types as much as possible.
  const completed = Value.Default(ConfigSchema, merged) as ResolvedConfig;
  const errors = Array.from(Value.Errors(ConfigSchema, completed));
  if (errors.length > 0) {
    const head = errors.slice(0, 5).map(formatErr).join("; ");
    throw new MemosError("config_invalid", `config failed schema validation: ${head}`, {
      errorCount: errors.length,
      first: errors.slice(0, 5).map((e) => ({ path: e.path, message: e.message })),
    });
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: completed.logging.timezone }).format(0);
  } catch {
    throw new MemosError("config_invalid", `invalid logging.timezone: ${completed.logging.timezone}`);
  }

  return Object.freeze(completed) as ResolvedConfig;
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Env var names accepted in `${NAME}` config references. */
const ENV_REF_ALLOWLIST = /^[A-Z][A-Z0-9_]*_(API_KEY|TOKEN)$/;

/**
 * Replace masked / empty / `${VAR}` secret leaves in `cleaned` (a freshly
 * built, non-shared object — see `pruneUnknown`) with values from the
 * environment. The caller's raw config object is never written to.
 */
function resolveSecretEnv(cleaned: Record<string, unknown>, warnings?: string[]): void {
  for (const dotted of SECRET_FIELD_PATHS) {
    const keys = dotted.split(".");
    let cursor: unknown = cleaned;
    // Explicit flag: `break` alone leaves `cursor` pointing at the last
    // valid value, which for paths deeper than 2 levels could accidentally
    // pass the `isPlainObject(cursor)` check below and index `leaf` on the
    // wrong node. Today every SECRET_FIELD_PATHS entry is only 2 levels
    // deep, but keeping the flag makes the intent explicit and future-
    // proofs against deeper paths being added.
    let traversalOk = true;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!isPlainObject(cursor)) {
        traversalOk = false;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[keys[i]!];
    }
    if (!traversalOk || !isPlainObject(cursor)) continue;
    const leaf = keys[keys.length - 1]!;
    const val = (cursor as Record<string, unknown>)[leaf];
    if (typeof val !== "string") continue;

    let envName: string | null = null;
    let warnIfMissing = false;
    if (val.startsWith("${") && val.endsWith("}")) {
      const name = val.slice(2, -1);
      if (!ENV_REF_ALLOWLIST.test(name)) {
        warnings?.push(
          `config: leaving '${dotted}' as '${val}' — env name '${name}' is not allowlisted ` +
            `(expected ^[A-Z][A-Z0-9_]*_(API_KEY|TOKEN)$)`
        );
        continue;
      }
      envName = name;
      warnIfMissing = true;
    } else if (val === "__memos_secret__" || val === "") {
      // Derive env var name from the field path itself so every entry
      // in SECRET_FIELD_PATHS is resolvable, not just the ones whose
      // leaf is `apiKey`:
      //   embedding.apiKey    → EMBEDDING_API_KEY
      //   llm.apiKey          → LLM_API_KEY
      //   l3Llm.apiKey        → L3_LLM_API_KEY
      //   skillEvolver.apiKey → SKILL_EVOLVER_API_KEY
      //   hub.teamToken       → HUB_TEAM_TOKEN
      //   hub.userToken       → HUB_USER_TOKEN
      const parent = keys[keys.length - 2] ?? "";
      envName = `${camelToUpperSnake(parent)}_${camelToUpperSnake(leaf)}`;
      warnIfMissing = val === "__memos_secret__";
    }
    if (!envName) continue;

    const envVal = process.env[envName] ?? resolveOpenCodeApiKey(cleaned, dotted);
    if (envVal) {
      (cursor as Record<string, unknown>)[leaf] = envVal;
    } else if (warnIfMissing) {
      warnings?.push(
        `config: '${dotted}' references env var '${envName}' but it is not set — ` +
          `field left as placeholder and auth will fail on the next call`
      );
    }
  }
}

/**
 * Resolve the provider-specific OpenCode fallback for the primary LLM only.
 * The hostname, provider and endpoint tier must all match so an OpenCode key
 * can never be sent to Anthropic, Gemini or another OpenAI-compatible host.
 */
function resolveOpenCodeApiKey(
  cleaned: Record<string, unknown>,
  dotted: string,
): string | undefined {
  if (dotted !== "llm.apiKey" || !isPlainObject(cleaned.llm)) return undefined;
  if (cleaned.llm.provider !== "openai_compatible") return undefined;

  const endpoint = cleaned.llm.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0) return undefined;

  try {
    const url = new URL(endpoint);
    if (url.hostname !== "opencode.ai") return undefined;
    if (/^\/zen\/go(?:\/|$)/.test(url.pathname)) {
      return process.env.OPENCODE_GO_API_KEY;
    }
    if (/^\/zen(?:\/|$)/.test(url.pathname)) {
      return process.env.OPENCODE_ZEN_API_KEY;
    }
  } catch {
    // Schema validation reports malformed endpoints later. Secret resolution
    // must not broaden fallback scope just because parsing failed here.
  }
  return undefined;
}

/**
 * camelCase → UPPER_SNAKE_CASE for deriving env var names from config
 * field paths. Only inserts an underscore at a lowercase/digit → uppercase
 * boundary so acronyms and digit runs stay intact:
 *   apiKey        → API_KEY
 *   teamToken     → TEAM_TOKEN
 *   userToken     → USER_TOKEN
 *   l3Llm         → L3_LLM
 *   skillEvolver  → SKILL_EVOLVER
 */
function camelToUpperSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function formatErr(e: ValueError): string {
  return `${e.path || "<root>"}: ${e.message}`;
}

/**
 * Recursively deep-merge `b` over `a`. Plain objects merge; arrays + scalars
 * get replaced wholesale. (We don't try to be clever about array merging —
 * surprises everyone.)
 *
 * Non-object tolerance at object-valued slots: when the default (`a[k]`) is
 * a plain object but the user value (`b[k]`) is null, undefined, empty
 * string, or any other non-object scalar, we keep the default object tree
 * intact. This handles half-written / legacy configs like:
 *
 *   skillEvolver:            # bare null
 *   skillEvolver: ""         # empty scalar
 *
 * Without this tolerance, Typebox's schema check explodes with
 * "Expected object" at load time and the whole daemon fails to start.
 * The writer will later re-hydrate these keys into proper maps when the
 * user patches nested fields via the Settings page.
 */
function deepMerge<T extends Record<string, unknown>>(a: T, b: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    const av = out[k];
    if (isPlainObject(av) && isPlainObject(v)) {
      out[k] = deepMerge(av as Record<string, unknown>, v as Record<string, unknown>);
    } else if (isPlainObject(av) && !isPlainObject(v)) {
      // Default is an object-valued slot; user put a scalar (null, "",
      // number, …). Ignore the scalar and keep the default tree so
      // schema validation passes. A warning was already emitted upstream
      // by `pruneUnknown` callers that care.
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Walk `raw` against `defaults` shape; record warnings for any keys that
 * have no counterpart (likely from a removed schema). We pass them through
 * anyway so older configs keep working.
 */
function pruneUnknown(
  raw: unknown,
  defaults: unknown,
  prefix: string,
  warnings?: string[],
): Record<string, unknown> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(defaults) && !(k in (defaults as Record<string, unknown>))) {
      warnings?.push(`unknown config key '${path}' (kept as-is for forward compatibility)`);
      out[k] = v;
      continue;
    }
    if (isPlainObject(v) && isPlainObject((defaults as Record<string, unknown>)[k])) {
      if (FREE_FORM_CONFIG_PATHS.includes(path)) {
        // Explicitly declared free-form maps keep user-defined child keys.
        // Other empty default objects remain structured config sections and
        // continue to report unknown nested keys.
        out[k] = v;
        continue;
      }
      out[k] = pruneUnknown(v, (defaults as Record<string, unknown>)[k], path, warnings);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function withLegacyEmbeddingInputLimit(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const embedding = isPlainObject(raw.embedding) ? raw.embedding : {};
  if (Object.hasOwn(embedding, "maxInputTokens")) return raw;
  return {
    ...raw,
    embedding: {
      ...embedding,
      maxInputTokens: 0,
    },
  };
}

function stripUnsupportedEmbeddingDimensions(merged: Record<string, unknown>): void {
  const embedding = merged.embedding;
  if (!isPlainObject(embedding)) return;
  // Vector dimensionality is derived from the model/provider at runtime,
  // not a user-facing config field. Ignore legacy/manual YAML values so
  // a stale `dimensions: 384` cannot truncate bge-m3's 1024-dim vectors.
  delete embedding.dimensions;
}

/**
 * One-shot helper for adapters that just want a fully resolved config for an
 * agent (handles both `MEMOS_HOME` overrides and the per-agent default).
 */
export async function loadConfigForAgent(
  agent: string,
  defaultHome?: string,
): Promise<{ home: ResolvedHome } & LoadConfigResult> {
  const home = resolveHome(agent, defaultHome);
  const result = await loadConfig(home, agent);
  return { home, ...result };
}

// Re-export for external value-level use
export { Type };
