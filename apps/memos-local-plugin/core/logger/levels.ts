/**
 * Level helpers. Re-exports the canonical level enum from the contract layer
 * and provides comparisons + per-channel resolution.
 */

import {
  LOG_LEVELS,
  LOG_LEVEL_ORDER,
  type LogLevel,
} from "../../agent-contract/log-record.js";

export { LOG_LEVELS, LOG_LEVEL_ORDER };
export type { LogLevel };

export function levelGte(a: LogLevel, b: LogLevel): boolean {
  return LOG_LEVEL_ORDER[a] >= LOG_LEVEL_ORDER[b];
}

export function isValidLevel(s: string): s is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(s);
}

export function parseLevel(s: string, fallback: LogLevel = "info"): LogLevel {
  return isValidLevel(s) ? s : fallback;
}

/**
 * Resolve the effective level for `channel` given the global level and a
 * channel→level overrides map. Longest-prefix wins; fall back to global.
 *
 *   overrides = { "core.l2": "debug", "core.l2.cross-task": "trace" }
 *   resolveLevelForChannel("core.l2.cross-task", "info", overrides) === "trace"
 *   resolveLevelForChannel("core.l2.incremental", "info", overrides) === "debug"
 *   resolveLevelForChannel("core.session", "info", overrides) === "info"
 */
export function resolveLevelForChannel(
  channel: string,
  globalLevel: LogLevel,
  overrides: Record<string, string>,
): LogLevel {
  let best: { len: number; lvl: LogLevel } | null = null;
  for (const [prefix, raw] of Object.entries(overrides ?? {})) {
    if (channel === prefix || channel.startsWith(prefix + ".")) {
      const lvl = parseLevel(raw, globalLevel);
      if (!best || prefix.length > best.len) best = { len: prefix.length, lvl };
    }
  }
  return best ? best.lvl : globalLevel;
}
