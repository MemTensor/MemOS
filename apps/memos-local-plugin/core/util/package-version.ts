import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Read this plugin's manifest in both source and compiled package layouts. */
export function readPluginPackageVersion(moduleUrl: string | URL = import.meta.url): string {
  const directory = dirname(fileURLToPath(moduleUrl));
  for (const parent of ["../../..", "../.."]) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(directory, parent, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name !== "@memtensor/memos-local-plugin") continue;
      return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version : "dev";
    } catch {
      // A source checkout and a packed install have different parent depths.
    }
  }
  return "dev";
}
