import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the plugin's installation root by walking up from the caller's file
 * until a `package.json` whose name matches `memos-local-openclaw-plugin` is found.
 *
 * Necessary because the build emits to `dist/` with `rootDir: "."`, so
 * compiled files live one extra level deep than their sources. Hard-coded
 * `../../` paths break across dev (src/) vs published (dist/src/) layouts.
 */
export function findPluginRoot(importMetaUrl: string): string {
  let dir = path.dirname(fileURLToPath(importMetaUrl));
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (typeof pkg.name === "string" && pkg.name.includes("memos-local")) return dir;
      } catch { /* keep walking */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`findPluginRoot: could not locate plugin root from ${importMetaUrl}`);
}
