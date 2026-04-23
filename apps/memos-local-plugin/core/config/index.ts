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
import { DEFAULT_CONFIG } from "./defaults.js";
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

export async function loadConfig(home: ResolvedHome): Promise<LoadConfigResult> {
  let raw: unknown = {};
  let fromDisk = false;
  const warnings: string[] = [];

  try {
    const text = await fs.readFile(home.configFile, "utf8");
    raw = parseYaml(text, home.configFile);
    fromDisk = true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      warnings.push(`config file not found at ${home.configFile}; using defaults`);
    } else if (MemosError.is(err)) {
      throw err;
    } else {
      throw new MemosError("config_invalid", `cannot read ${home.configFile}: ${e.message}`, {
        source: home.configFile,
      });
    }
  }

  const config = resolveConfig(raw, warnings);
  return { config, fromDisk, warnings, source: home.configFile };
}

/**
 * Merge an arbitrary raw object over `DEFAULT_CONFIG` and validate. Used in
 * tests and by `writer.ts`. `warnings` is mutated in place if provided.
 */
export function resolveConfig(raw: unknown, warnings?: string[]): ResolvedConfig {
  const cleaned = pruneUnknown(raw, DEFAULT_CONFIG, "", warnings);
  const merged = deepMerge(DEFAULT_CONFIG as Record<string, unknown>, cleaned);

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

  return Object.freeze(completed) as ResolvedConfig;
}

// ─── helpers ────────────────────────────────────────────────────────────────

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

/**
 * One-shot helper for adapters that just want a fully resolved config for an
 * agent (handles both `MEMOS_HOME` overrides and the per-agent default).
 */
export async function loadConfigForAgent(
  agent: string,
  defaultHome?: string,
): Promise<{ home: ResolvedHome } & LoadConfigResult> {
  const home = resolveHome(agent, defaultHome);
  const result = await loadConfig(home);
  return { home, ...result };
}

// Re-export for external value-level use
export { Type };
