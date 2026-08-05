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

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

function expandHomePath(value: string, env: EnvLike): string {
  let out = value;
  const home =
    (typeof env["HOME"] === "string" && env["HOME"]) ||
    (typeof env["USERPROFILE"] === "string" && env["USERPROFILE"]) ||
    homedir();
  if (out === "~") out = home;
  else if (out.startsWith("~/") || out.startsWith("~\\")) {
    out = join(home, out.slice(2));
  }
  return pathResolve(out);
}

export function resolveHermesHome(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const hermesHome = (env["HERMES_HOME"] ?? "").trim();
  if (hermesHome) return expandHomePath(hermesHome, env);

  if (platform === "win32") {
    const localAppData = (env["LOCALAPPDATA"] ?? "").trim();
    if (localAppData) return pathResolve(join(expandHomePath(localAppData, env), "hermes"));
    // Match Hermes' own fallback when LOCALAPPDATA is unset.
    const home =
      (typeof env["USERPROFILE"] === "string" && env["USERPROFILE"]) ||
      (typeof env["HOME"] === "string" && env["HOME"]) ||
      homedir();
    return pathResolve(join(expandHomePath(home, env), "AppData", "Local", "hermes"));
  }

  const home =
    (typeof env["HOME"] === "string" && env["HOME"]) ||
    homedir();
  return pathResolve(join(expandHomePath(home, env), ".hermes"));
}
