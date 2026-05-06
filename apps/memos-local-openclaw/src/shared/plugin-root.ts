import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Exact package names recognized as this plugin's installation root.
 *
 * Kept narrow (not a substring match) so monorepo layouts — where sibling
 * packages such as `memos-local-plugin` live next to `memos-local-openclaw` —
 * can never accidentally lock onto the wrong root.
 *
 * The unscoped form covers historical / local checkouts; the scoped form is
 * the published name on npm.
 */
const PLUGIN_PACKAGE_NAMES = new Set([
  "memos-local-openclaw-plugin",
  "@memtensor/memos-local-openclaw-plugin",
]);

/**
 * Resolve the plugin's installation root by walking up from the caller's file
 * until a `package.json` whose `name` matches one of {@link PLUGIN_PACKAGE_NAMES}
 * is found.
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
        if (typeof pkg.name === "string" && PLUGIN_PACKAGE_NAMES.has(pkg.name)) return dir;
      } catch { /* keep walking */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`findPluginRoot: could not locate plugin root from ${importMetaUrl}`);
}
