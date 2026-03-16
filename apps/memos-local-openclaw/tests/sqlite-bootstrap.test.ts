import { describe, expect, it, vi } from "vitest";
import {
  ensureBetterSqlite3Available,
  getPluginDirFromImportMeta,
  isPathWithinDir,
  type BetterSqliteRuntime,
} from "../src/runtime/sqlite-bootstrap";

function makeApi() {
  const info = vi.fn();
  const warn = vi.fn();

  return {
    api: { logger: { info, warn } },
    info,
    warn,
  };
}

describe("sqlite bootstrap path handling", () => {
  it("converts import.meta.url into a real Windows filesystem path", () => {
    const pluginDir = getPluginDirFromImportMeta(
      "file:///C:/Users/nowcoder/.openclaw/extensions/memos-local-openclaw-plugin/index.ts",
      "win32",
    );

    expect(pluginDir).toBe("C:\\Users\\nowcoder\\.openclaw\\extensions\\memos-local-openclaw-plugin");
  });

  it("keeps compatibility with Node runtimes that only expose the one-argument fileURLToPath", () => {
    const pluginDir = getPluginDirFromImportMeta(
      "file:///C:/Program%20Files/OpenClaw/plugins/memos-local-openclaw-plugin/index.ts",
      "win32",
    );

    expect(pluginDir).toBe("C:\\Program Files\\OpenClaw\\plugins\\memos-local-openclaw-plugin");
  });

  it("treats Windows paths with slash and case differences as the same directory", () => {
    expect(
      isPathWithinDir(
        "c:/users/nowcoder/.openclaw/extensions/memos-local-openclaw-plugin/node_modules/better-sqlite3/lib/index.js",
        "C:\\Users\\nowcoder\\.openclaw\\extensions\\memos-local-openclaw-plugin",
        "win32",
      ),
    ).toBe(true);
  });

  it("rejects sibling directories that only share a string prefix", () => {
    expect(
      isPathWithinDir(
        "C:/Users/nowcoder/.openclaw/extensions/memos-local-openclaw-plugin-bad/node_modules/better-sqlite3/index.js",
        "C:\\Users\\nowcoder\\.openclaw\\extensions\\memos-local-openclaw-plugin",
        "win32",
      ),
    ).toBe(false);
  });

  it("allows child directories whose names start with two dots", () => {
    expect(
      isPathWithinDir(
        "C:/Users/nowcoder/.openclaw/extensions/memos-local-openclaw-plugin/..cache/better-sqlite3/index.js",
        "C:\\Users\\nowcoder\\.openclaw\\extensions\\memos-local-openclaw-plugin",
        "win32",
      ),
    ).toBe(true);
  });
});

describe("ensureBetterSqlite3Available", () => {
  it("does not rebuild when better-sqlite3 resolves inside the plugin dir on Windows", () => {
    const { api } = makeApi();
    const runtime: BetterSqliteRuntime = {
      resolveFromPluginDir: vi
        .fn()
        .mockReturnValue(
          "C:/Users/nowcoder/.openclaw/extensions/memos-local-openclaw-plugin/node_modules/better-sqlite3/lib/index.js",
        ),
      load: vi.fn(),
      rebuild: vi.fn(),
      clearCache: vi.fn(),
    };

    const pluginDir = ensureBetterSqlite3Available(
      api,
      "file:///C:/Users/nowcoder/.openclaw/extensions/memos-local-openclaw-plugin/index.ts",
      { platform: "win32", runtime },
    );

    expect(pluginDir).toBe("C:\\Users\\nowcoder\\.openclaw\\extensions\\memos-local-openclaw-plugin");
    expect(runtime.load).toHaveBeenCalledTimes(1);
    expect(runtime.rebuild).not.toHaveBeenCalled();
  });

  it("rebuilds once when the initial resolution falls outside the plugin dir", () => {
    const { api, info, warn } = makeApi();
    const runtime: BetterSqliteRuntime = {
      resolveFromPluginDir: vi
        .fn()
        .mockReturnValueOnce("C:/Users/nowcoder/.openclaw/extensions/shared/node_modules/better-sqlite3/index.js")
        .mockReturnValueOnce(
          "C:/Users/nowcoder/.openclaw/extensions/memos-local-openclaw-plugin/node_modules/better-sqlite3/index.js",
        ),
      load: vi.fn(),
      rebuild: vi.fn().mockReturnValue({ status: 0, stdout: "rebuilt", stderr: "" }),
      clearCache: vi.fn(),
    };

    const pluginDir = ensureBetterSqlite3Available(
      api,
      "file:///C:/Users/nowcoder/.openclaw/extensions/memos-local-openclaw-plugin/index.ts",
      { platform: "win32", runtime },
    );

    expect(pluginDir).toBe("C:\\Users\\nowcoder\\.openclaw\\extensions\\memos-local-openclaw-plugin");
    expect(runtime.rebuild).toHaveBeenCalledWith(pluginDir);
    expect(runtime.clearCache).toHaveBeenCalledTimes(1);
    expect(runtime.load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("better-sqlite3 resolved outside plugin dir"),
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining("auto-rebuild succeeded"));
  });
});
