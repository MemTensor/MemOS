import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../../../core/config/index.js";
import { makeTmpHome } from "../../helpers/tmp-home.js";

describe("Hermes viewer-port migration", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it("backs up and migrates the known bad 18799 value exactly once", async () => {
    const original = "# keep me\nviewer:\n  port: 18799 # wrong v2 value\nllm:\n  endpoint: https://example.test/v1\n";
    const ctx = await makeTmpHome({ agent: "hermes", configYaml: original });
    cleanup = ctx.cleanup;

    const loaded = await loadConfig(ctx.home, "hermes");
    expect(loaded.config.viewer.port).toBe(18800);
    expect(await fs.readFile(ctx.home.configFile, "utf8")).toMatch(/port:\s*18800/);

    const migrationsDir = join(ctx.home.root, ".migrations");
    const marker = JSON.parse(await fs.readFile(
      join(migrationsDir, "hermes-viewer-port-v1.json"),
      "utf8",
    ));
    expect(marker).toMatchObject({ version: 1, from: 18799, to: 18800 });
    const backupPath = join(migrationsDir, marker.backup);
    expect(await fs.readFile(backupPath, "utf8")).toBe(original);
    if (process.platform !== "win32") {
      expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
    }

    await loadConfig(ctx.home, "hermes");
    expect(await fs.readFile(backupPath, "utf8")).toBe(original);
  });

  it("does not rewrite a custom port during the one-time migration", async () => {
    const original = "viewer:\n  port: 19000\n";
    const ctx = await makeTmpHome({ agent: "hermes", configYaml: original });
    cleanup = ctx.cleanup;

    const loaded = await loadConfig(ctx.home, "hermes");

    expect(loaded.config.viewer.port).toBe(18800);
    expect(await fs.readFile(ctx.home.configFile, "utf8")).toBe(original);
  });

  it("serializes concurrent first loads into one backup and migration", async () => {
    const original = "viewer:\n  port: 18799\n";
    const ctx = await makeTmpHome({ agent: "hermes", configYaml: original });
    cleanup = ctx.cleanup;

    const results = await Promise.all([
      loadConfig(ctx.home, "hermes"),
      loadConfig(ctx.home, "hermes"),
      loadConfig(ctx.home, "hermes"),
    ]);

    expect(results.every((result) => result.config.viewer.port === 18800)).toBe(true);
    const files = await fs.readdir(join(ctx.home.root, ".migrations"));
    expect(files.filter((name) => name.endsWith(".bak"))).toHaveLength(1);
    expect(files.some((name) => name.endsWith(".lock"))).toBe(false);
  });

  it("leaves invalid YAML untouched and does not mark migration complete", async () => {
    const original = "viewer: [\n";
    const ctx = await makeTmpHome({ agent: "hermes" });
    cleanup = ctx.cleanup;
    await fs.writeFile(ctx.home.configFile, original, "utf8");

    await expect(loadConfig(ctx.home, "hermes")).rejects.toThrow();
    expect(await fs.readFile(ctx.home.configFile, "utf8")).toBe(original);
    await expect(fs.access(join(ctx.home.root, ".migrations", "hermes-viewer-port-v1.json")))
      .rejects.toThrow();
  });
});
