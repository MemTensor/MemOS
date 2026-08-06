import { describe, expect, it, vi, afterEach } from "vitest";

// Path-utils must be platform-aware: on Windows it lower-cases and rewrites
// backslashes / drive-letter URL-pathname / extended-length prefixes; on
// POSIX it stays case-sensitive and idempotent.
//
// To exercise the win32 branch from a Linux CI box we have to stub
// `process.platform` *before* importing the module so the platform branch
// is captured at evaluation time. We use vi.resetModules() between cases.

async function loadFor(platform: "win32" | "linux" | "darwin") {
  vi.resetModules();
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    const mod = await import("../src/path-utils");
    return { mod, restore: () => {
      if (original) Object.defineProperty(process, "platform", original);
    } };
  } catch (err) {
    if (original) Object.defineProperty(process, "platform", original);
    throw err;
  }
}

afterEach(() => {
  vi.resetModules();
});

describe("normalizeFsPath (win32)", () => {
  it("normalises plain Windows absolute paths to lowercase forward-slash form", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      expect(mod.normalizeFsPath("C:\\Users\\Admin\\.openclaw-dev\\extensions\\memos-local-openclaw-plugin"))
        .toBe("c:/users/admin/.openclaw-dev/extensions/memos-local-openclaw-plugin");
    } finally { restore(); }
  });

  it("accepts forward-slash Windows paths", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      expect(mod.normalizeFsPath("c:/Users/Admin/.openclaw-dev/extensions/memos-local-openclaw-plugin"))
        .toBe("c:/users/admin/.openclaw-dev/extensions/memos-local-openclaw-plugin");
    } finally { restore(); }
  });

  it("strips the leading slash that precedes a drive letter (URL pathname form)", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      expect(mod.normalizeFsPath("/C:/Users/Admin/.openclaw-dev/extensions/memos-local-openclaw-plugin"))
        .toBe("c:/users/admin/.openclaw-dev/extensions/memos-local-openclaw-plugin");
    } finally { restore(); }
  });

  it("strips the \\\\?\\ long-path prefix", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      expect(mod.normalizeFsPath("\\\\?\\C:\\Users\\Admin\\.openclaw-dev\\extensions\\memos-local-openclaw-plugin"))
        .toBe("c:/users/admin/.openclaw-dev/extensions/memos-local-openclaw-plugin");
    } finally { restore(); }
  });

  it("converts \\\\?\\UNC\\server\\share to //server/share", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      expect(mod.normalizeFsPath("\\\\?\\UNC\\server\\share\\plugin"))
        .toBe("//server/share/plugin");
    } finally { restore(); }
  });

  it("idempotently normalises an already-normalised path", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      const once = mod.normalizeFsPath("C:\\Users\\Admin\\plugin");
      expect(mod.normalizeFsPath(once)).toBe(once);
    } finally { restore(); }
  });
});

describe("normalizeFsPath (posix)", () => {
  it("does not lowercase POSIX paths", async () => {
    const { mod, restore } = await loadFor("linux");
    try {
      expect(mod.normalizeFsPath("/Home/User/.openclaw/plugin"))
        .toBe("/Home/User/.openclaw/plugin");
    } finally { restore(); }
  });

  it("normalises ./ and ../ segments", async () => {
    const { mod, restore } = await loadFor("linux");
    try {
      expect(mod.normalizeFsPath("/home/user/./.openclaw/../.openclaw/plugin"))
        .toBe("/home/user/.openclaw/plugin");
    } finally { restore(); }
  });
});

describe("isPathInside (win32)", () => {
  it("returns true for the exact same Windows directory", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      const base = "C:\\Users\\Admin\\.openclaw-dev\\extensions\\memos-local-openclaw-plugin";
      expect(mod.isPathInside(base, base)).toBe(true);
    } finally { restore(); }
  });

  it("returns true when target is a child of base", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      const base = "C:\\Users\\Admin\\.openclaw-dev\\extensions\\memos-local-openclaw-plugin";
      const target = "C:\\Users\\Admin\\.openclaw-dev\\extensions\\memos-local-openclaw-plugin\\node_modules\\better-sqlite3\\lib\\index.js";
      expect(mod.isPathInside(base, target)).toBe(true);
    } finally { restore(); }
  });

  it("handles the /C:/ URL-pathname base against a native target — the exact #1358 case", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      const base = "/C:/Users/Admin/.openclaw-dev/extensions/memos-local-openclaw-plugin";
      const target = "C:\\Users\\Admin\\.openclaw-dev\\extensions\\memos-local-openclaw-plugin\\node_modules\\better-sqlite3\\lib\\index.js";
      expect(mod.isPathInside(base, target)).toBe(true);
    } finally { restore(); }
  });

  it("handles case difference in the drive letter", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      const base = "C:\\Users\\Admin\\plugin";
      const target = "c:\\users\\admin\\plugin\\node_modules\\x";
      expect(mod.isPathInside(base, target)).toBe(true);
    } finally { restore(); }
  });

  it("handles mixed slash directions", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      const base = "C:\\Users\\Admin\\plugin";
      const target = "C:/Users/Admin/plugin/sub/file.js";
      expect(mod.isPathInside(base, target)).toBe(true);
    } finally { restore(); }
  });

  it("handles the \\\\?\\ long-path prefix on one side only", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      const base = "C:\\Users\\Admin\\plugin";
      const target = "\\\\?\\C:\\Users\\Admin\\plugin\\node_modules\\x\\index.js";
      expect(mod.isPathInside(base, target)).toBe(true);
    } finally { restore(); }
  });

  it("returns false when target sits in a sibling directory", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      const base = "C:\\Users\\Admin\\plugin";
      const target = "C:\\Users\\Admin\\other-plugin\\node_modules\\x\\index.js";
      expect(mod.isPathInside(base, target)).toBe(false);
    } finally { restore(); }
  });

  it("returns false when target sits in the parent's node_modules (hoisted dep)", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      const base = "C:\\Users\\Admin\\plugin";
      const target = "C:\\Users\\Admin\\node_modules\\x\\index.js";
      expect(mod.isPathInside(base, target)).toBe(false);
    } finally { restore(); }
  });

  it("returns false when target is on a different drive", async () => {
    const { mod, restore } = await loadFor("win32");
    try {
      const base = "C:\\Users\\Admin\\plugin";
      const target = "D:\\Users\\Admin\\plugin\\node_modules\\x\\index.js";
      expect(mod.isPathInside(base, target)).toBe(false);
    } finally { restore(); }
  });
});

describe("isPathInside (posix)", () => {
  it("returns true for the exact same POSIX directory", async () => {
    const { mod, restore } = await loadFor("linux");
    try {
      const base = "/home/user/.openclaw/extensions/memos-local-openclaw-plugin";
      expect(mod.isPathInside(base, base)).toBe(true);
    } finally { restore(); }
  });

  it("returns true for a child path", async () => {
    const { mod, restore } = await loadFor("linux");
    try {
      const base = "/home/user/.openclaw/extensions/memos-local-openclaw-plugin";
      const target = "/home/user/.openclaw/extensions/memos-local-openclaw-plugin/node_modules/better-sqlite3/lib/index.js";
      expect(mod.isPathInside(base, target)).toBe(true);
    } finally { restore(); }
  });

  it("returns false for a sibling", async () => {
    const { mod, restore } = await loadFor("linux");
    try {
      const base = "/home/user/.openclaw/extensions/memos-local-openclaw-plugin";
      const target = "/home/user/.openclaw/extensions/other-plugin/node_modules/x/index.js";
      expect(mod.isPathInside(base, target)).toBe(false);
    } finally { restore(); }
  });

  it("returns false when case differs on a case-sensitive filesystem", async () => {
    const { mod, restore } = await loadFor("linux");
    try {
      const base = "/home/user/plugin";
      const target = "/Home/User/plugin/node_modules/x/index.js";
      expect(mod.isPathInside(base, target)).toBe(false);
    } finally { restore(); }
  });
});
