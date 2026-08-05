/**
 * Canonical Hermes home resolver, shared by the plugin's bridge entries,
 * `core/config/paths.ts`, and the server routes that reach into the
 * Hermes host workspace-src-admin-dashboard for legacy/native imports.
 *
 * Mirrors Hermes' own `_get_platform_default_hermes_home` so the
 * plugin's runtime state, PID files, and import sources land inside the
 * directory the Hermes daemon actually reads:
 *
 *   1. `HERMES_HOME` env override (works on every platform).
 *   2. On win32: `%LOCALAPPDATA%\hermes` (fallback: `<home>/AppData/Local/hermes`).
 *   3. On any other platform: `~/.hermes`.
 *
 * Callers should not hardcode `~/.hermes`; issue #2221 exists because
 * they historically did.
 */

import { homedir } from "node:os";
import { resolve as pathResolve, join } from "node:path";

/**
 * Structural env type; matches `process.env` but stays usable in tests
 * that build a plain object without pulling in the whole `NodeJS.ProcessEnv`
 * shape. Exported so callers who construct typed mock envs can share it.
 */
export type EnvLike = Record<string, string | undefined>;

/**
 * Resolve the current user's home directory using the same precedence as
 * Hermes' Python resolver: on Windows prefer `USERPROFILE`, on POSIX
 * prefer `HOME`, falling back to node's `homedir()` on both. Empty
 * strings are treated as unset so a scrubbed env doesn't collapse the
 * fallback chain.
 */
function resolveHome(env: EnvLike, platform: NodeJS.Platform): string {
  const homeEnv = (env["HOME"] ?? "").trim();
  const userProfile = (env["USERPROFILE"] ?? "").trim();
  if (platform === "win32") {
    if (userProfile) return userProfile;
    if (homeEnv) return homeEnv;
  } else {
    if (homeEnv) return homeEnv;
    if (userProfile) return userProfile;
  }
  return homedir();
}

/**
 * Expand a leading `~` against the supplied `home`. Only the bare `~`,
 * `~/…` and `~\…` forms are supported — POSIX-style `~username/…`
 * expansion is deliberately out of scope, so it raises rather than
 * silently resolving relative to CWD.
 */
function expandHomePath(value: string, home: string): string {
  let out = value;
  if (out === "~") {
    out = home;
  } else if (out.startsWith("~/") || out.startsWith("~\\")) {
    out = join(home, out.slice(2));
  } else if (out.startsWith("~")) {
    throw new Error(
      `named-user tilde paths are not supported: ${JSON.stringify(value)}`,
    );
  }
  return pathResolve(out);
}

export function resolveHermesHome(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = resolveHome(env, platform);

  const hermesHome = (env["HERMES_HOME"] ?? "").trim();
  if (hermesHome) return expandHomePath(hermesHome, home);

  if (platform === "win32") {
    const localAppData = (env["LOCALAPPDATA"] ?? "").trim();
    if (localAppData) return pathResolve(join(localAppData, "hermes"));
    // Match Hermes' own fallback when LOCALAPPDATA is unset.
    return pathResolve(join(home, "AppData", "Local", "hermes"));
  }

  return pathResolve(join(home, ".hermes"));
}
