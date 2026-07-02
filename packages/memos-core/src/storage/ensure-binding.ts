import { existsSync, mkdirSync, copyFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { createRequire } from "module";

/**
 * Ensure the better-sqlite3 native binary is available.
 *
 * OpenClaw installs plugins with `--ignore-scripts`, which skips
 * the native compilation step. This function checks for the binary
 * and restores it from bundled prebuilds if missing.
 */
export function ensureSqliteBinding(log?: { info: (msg: string) => void; warn: (msg: string) => void }): void {
  const _req = typeof require !== "undefined" ? require : createRequire(__filename);
  const bsqlPkg = _req.resolve("better-sqlite3/package.json");
  const bsqlDir = path.dirname(bsqlPkg);
  const bindingPath = path.join(bsqlDir, "build", "Release", "better_sqlite3.node");

  if (existsSync(bindingPath)) return;

  const platform = `${process.platform}-${process.arch}`;
  const pluginRoot = path.resolve(__dirname, "..", "..");
  const prebuildSrc = path.join(pluginRoot, "prebuilds", platform, "better_sqlite3.node");

  if (existsSync(prebuildSrc)) {
    log?.info(`[ensure-binding] Copying prebuild for ${platform}...`);
    mkdirSync(path.dirname(bindingPath), { recursive: true });
    copyFileSync(prebuildSrc, bindingPath);
    log?.info(`[ensure-binding] Prebuild installed successfully.`);
    return;
  }

  log?.warn(`[ensure-binding] No prebuild for ${platform}, attempting npm rebuild...`);
  try {
    const installDir = path.resolve(bsqlDir, "..", "..");
    execSync("npm rebuild better-sqlite3", {
      cwd: installDir,
      stdio: "pipe",
      timeout: 180_000,
    });
    if (existsSync(bindingPath)) {
      log?.info(`[ensure-binding] Rebuilt better-sqlite3 successfully.`);
      return;
    }
  } catch { /* fall through */ }

  throw new Error(
    `better-sqlite3 native binary not found for ${platform}.\n` +
    `Prebuild not bundled and npm rebuild failed.\n` +
    `Fix: cd ${path.resolve(bsqlDir, "..", "..")} && npm rebuild better-sqlite3`,
  );
}
