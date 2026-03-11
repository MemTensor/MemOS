import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

type BootstrapApi = {
  logger: Logger;
};

type RebuildResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type BetterSqliteRuntime = {
  resolveFromPluginDir: (pluginDir: string) => string;
  load: (resolvedPath: string) => void;
  rebuild: (pluginDir: string) => RebuildResult;
  clearCache: () => void;
};

function fileUrlToPathWithWindowsFallback(
  importMetaUrl: string,
  platform: NodeJS.Platform,
): string {
  const nativePath = fileURLToPath(importMetaUrl);
  if (platform !== "win32" || process.platform === "win32" || !/^\/[A-Za-z]:/.test(nativePath)) {
    return nativePath;
  }

  const parsedUrl = new URL(importMetaUrl);
  if (parsedUrl.protocol !== "file:") {
    return nativePath;
  }

  if (parsedUrl.hostname) {
    const uncPath = decodeURIComponent(parsedUrl.pathname || "").replace(/\//g, "\\");
    return `\\\\${parsedUrl.hostname}${uncPath}`;
  }

  let pathname = decodeURIComponent(parsedUrl.pathname || "");
  if (/^\/[A-Za-z]:/.test(pathname)) {
    pathname = pathname.slice(1);
  }

  return pathname.replace(/\//g, "\\");
}

export function getPluginDirFromImportMeta(
  importMetaUrl: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.dirname(fileUrlToPathWithWindowsFallback(importMetaUrl, platform));
}

function canonicalizePath(fsPath: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  let resolved = pathApi.resolve(fsPath);
  if (platform === process.platform) {
    try {
      resolved = fs.realpathSync.native?.(fsPath) ?? fs.realpathSync(fsPath);
    } catch {
      resolved = pathApi.resolve(fsPath);
    }
  }

  if (platform === "win32") {
    return resolved.replace(/\//g, "\\").toLowerCase();
  }

  return resolved;
}

export function isPathWithinDir(
  candidatePath: string,
  baseDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const candidate = canonicalizePath(candidatePath, platform);
  const base = canonicalizePath(baseDir, platform);
  const relative = pathApi.relative(base, candidate);

  return (
    relative === "" ||
    (!(relative === ".." || relative.startsWith(`..${pathApi.sep}`)) && !pathApi.isAbsolute(relative))
  );
}

function createBetterSqliteRuntime(importMetaUrl: string): BetterSqliteRuntime {
  const runtimeRequire = createRequire(importMetaUrl);

  return {
    resolveFromPluginDir(pluginDir: string): string {
      return runtimeRequire.resolve("better-sqlite3", { paths: [pluginDir] });
    },
    load(resolvedPath: string): void {
      runtimeRequire(resolvedPath);
    },
    rebuild(pluginDir: string): RebuildResult {
      return spawnSync("npm", ["rebuild", "better-sqlite3"], {
        cwd: pluginDir,
        stdio: "pipe",
        shell: true,
        timeout: 120_000,
      });
    },
    clearCache(): void {
      Object.keys(runtimeRequire.cache)
        .filter((cacheKey) => cacheKey.includes("better-sqlite3") || cacheKey.includes("better_sqlite3"))
        .forEach((cacheKey) => delete runtimeRequire.cache[cacheKey]);
    },
  };
}

function tryLoadBetterSqlite(
  api: BootstrapApi,
  pluginDir: string,
  platform: NodeJS.Platform,
  runtime: BetterSqliteRuntime,
): boolean {
  try {
    const resolved = runtime.resolveFromPluginDir(pluginDir);
    if (!isPathWithinDir(resolved, pluginDir, platform)) {
      api.logger.warn(`memos-local: better-sqlite3 resolved outside plugin dir: ${resolved}`);
      return false;
    }

    runtime.load(resolved);
    return true;
  } catch {
    return false;
  }
}

function formatOutputSnippet(output: string | Buffer | null | undefined): string {
  if (!output) {
    return "";
  }

  return output.toString().slice(0, 500);
}

export function ensureBetterSqlite3Available(
  api: BootstrapApi,
  importMetaUrl: string,
  options: {
    platform?: NodeJS.Platform;
    runtime?: BetterSqliteRuntime;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const pluginDir = getPluginDirFromImportMeta(importMetaUrl, platform);
  const runtime = options.runtime ?? createBetterSqliteRuntime(importMetaUrl);

  let sqliteReady = tryLoadBetterSqlite(api, pluginDir, platform, runtime);
  if (sqliteReady) {
    return pluginDir;
  }

  api.logger.warn(`memos-local: better-sqlite3 not found in ${pluginDir}, attempting auto-rebuild ...`);

  try {
    const rebuildResult = runtime.rebuild(pluginDir);
    const stdout = formatOutputSnippet(rebuildResult.stdout);
    const stderr = formatOutputSnippet(rebuildResult.stderr);

    if (stdout) {
      api.logger.info(`memos-local: rebuild stdout: ${stdout}`);
    }
    if (stderr) {
      api.logger.warn(`memos-local: rebuild stderr: ${stderr}`);
    }

    if (rebuildResult.status === 0) {
      runtime.clearCache();
      sqliteReady = tryLoadBetterSqlite(api, pluginDir, platform, runtime);
      if (sqliteReady) {
        api.logger.info("memos-local: better-sqlite3 auto-rebuild succeeded!");
      } else {
        api.logger.warn("memos-local: rebuild exited 0 but module still not loadable from plugin dir");
      }
    } else {
      api.logger.warn(`memos-local: rebuild exited with code ${rebuildResult.status}`);
    }
  } catch (rebuildErr) {
    api.logger.warn(`memos-local: auto-rebuild error: ${rebuildErr}`);
  }

  if (sqliteReady) {
    return pluginDir;
  }

  const msg = [
    "",
    "╔══════════════════════════════════════════════════════════════╗",
    "║  MemOS Local Memory — better-sqlite3 native module missing  ║",
    "╠══════════════════════════════════════════════════════════════╣",
    "║                                                            ║",
    "║  Auto-rebuild failed. Run these commands manually:         ║",
    "║                                                            ║",
    `║  cd ${pluginDir}`,
    "║  npm rebuild better-sqlite3                                ║",
    "║  openclaw gateway stop && openclaw gateway start           ║",
    "║                                                            ║",
    "║  If rebuild fails, install build tools first:              ║",
    "║  macOS:  xcode-select --install                            ║",
    "║  Linux:  sudo apt install build-essential python3          ║",
    "║                                                            ║",
    "╚══════════════════════════════════════════════════════════════╝",
    "",
  ].join("\n");
  api.logger.warn(msg);
  throw new Error(
    `better-sqlite3 native module not found. Auto-rebuild failed. Fix: cd ${pluginDir} && npm rebuild better-sqlite3`,
  );
}
