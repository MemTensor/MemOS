import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { readPluginPackageVersion } from "../../../core/util/package-version.js";

describe("plugin package version", () => {
  it.each(["core/util", "dist/core/util"])("reads the plugin manifest from %s even inside another package", (layout) => {
    const parent = mkdtempSync(resolve(tmpdir(), "memos-version-"));
    const root = resolve(parent, "plugin");
    mkdirSync(resolve(root, layout), { recursive: true });
    writeFileSync(resolve(parent, "package.json"), JSON.stringify({ name: "unrelated-host", version: "99.0.0" }));
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "@memtensor/memos-local-plugin", version: "2.0.21-beta.1" }));
    try {
      expect(readPluginPackageVersion(pathToFileURL(resolve(root, layout, "package-version.js")))).toBe("2.0.21-beta.1");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each(["missing", "invalid", "empty-version"])("falls back to dev for a %s manifest", (kind) => {
    const root = mkdtempSync(resolve(tmpdir(), "memos-version-"));
    mkdirSync(resolve(root, "core/util"), { recursive: true });
    if (kind !== "missing") writeFileSync(resolve(root, "package.json"), kind === "invalid" ? "{" : JSON.stringify({ name: "@memtensor/memos-local-plugin", version: " " }));
    try {
      expect(readPluginPackageVersion(pathToFileURL(resolve(root, "core/util/package-version.js")))).toBe("dev");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
