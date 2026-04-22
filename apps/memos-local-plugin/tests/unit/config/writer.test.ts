import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { statSync } from "node:fs";

import { loadConfig } from "../../../core/config/index.js";
import { patchConfig } from "../../../core/config/writer.js";
import { makeTmpHome } from "../../helpers/tmp-home.js";

describe("config/patchConfig", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it("writes a brand-new config file when none exists, with mode 600", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    await fs.rm(ctx.home.configFile, { force: true });

    const result = await patchConfig(ctx.home, { llm: { temperature: 0.3 } });
    expect(result.created).toBe(true);
    expect(result.config.llm.temperature).toBe(0.3);

    const text = await fs.readFile(ctx.home.configFile, "utf8");
    expect(text).toMatch(/temperature:\s*0\.3/);

    if (process.platform !== "win32") {
      const mode = statSync(ctx.home.configFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("preserves user comments and field ordering when patching", async () => {
    const original = `# my notes
viewer:
  port: 18910            # the viewer port
  bindHost: 127.0.0.1
llm:
  provider: host
  temperature: 0
`;
    const ctx = await makeTmpHome({ agent: "openclaw", configYaml: original });
    cleanup = ctx.cleanup;
    await patchConfig(ctx.home, { llm: { temperature: 0.7 } });
    const text = await fs.readFile(ctx.home.configFile, "utf8");
    expect(text).toMatch(/^# my notes/);
    expect(text).toMatch(/the viewer port/);
    expect(text).toMatch(/temperature:\s*0\.7/);
    // viewer.port stays where it was
    const idxViewer = text.indexOf("viewer");
    const idxLlm = text.indexOf("llm");
    expect(idxViewer).toBeLessThan(idxLlm);
  });

  it("validates after merge — invalid patches are rejected", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    await expect(patchConfig(ctx.home, { viewer: { port: -3 } as Record<string, unknown> }))
      .rejects.toThrow(/schema validation/);
  });

  it("subsequent loadConfig sees the patched values", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    await patchConfig(ctx.home, { algorithm: { skill: { minSupport: 7 } } });
    const reloaded = await loadConfig(ctx.home);
    expect(reloaded.config.algorithm.skill.minSupport).toBe(7);
  });

  /**
   * Regression: before commit <yaml-map-fix>, patching a nested map slot
   * whose existing value was a bare-null scalar (`skillEvolver:`), an
   * empty string (`skillEvolver: ""`), or otherwise not a YAMLMap would
   * throw `Expected YAML collection at skillEvolver. Remaining path: provider`
   * because `doc.setIn(['skillEvolver'], {})` doesn't replace a Scalar
   * with a Map in the `yaml` lib. The fix uses `new YAMLMap()` explicitly
   * whenever the existing node isn't already a Map.
   */
  it("repairs a scalar-valued intermediate key when patching nested fields", async () => {
    const broken = `llm:
  provider: openai_compatible
  endpoint: "https://api.openai.com/v1"
  model: gpt-4o-mini
skillEvolver:
`;
    const ctx = await makeTmpHome({ agent: "openclaw", configYaml: broken });
    cleanup = ctx.cleanup;
    const result = await patchConfig(ctx.home, {
      skillEvolver: { provider: "openai_compatible", apiKey: "sk-test" },
    });
    expect(result.config.skillEvolver.provider).toBe("openai_compatible");
    const text = await fs.readFile(ctx.home.configFile, "utf8");
    expect(text).toMatch(/skillEvolver:\n\s+provider:\s*openai_compatible/);
  });

  it("repairs an empty-string intermediate key when patching nested fields", async () => {
    const broken = `llm:
  provider: openai_compatible
  endpoint: "https://api.openai.com/v1"
  model: gpt-4o-mini
skillEvolver: ""
`;
    const ctx = await makeTmpHome({ agent: "openclaw", configYaml: broken });
    cleanup = ctx.cleanup;
    await patchConfig(ctx.home, {
      skillEvolver: { provider: "gemini", model: "gemini-2.5-flash" },
    });
    const reloaded = await loadConfig(ctx.home);
    expect(reloaded.config.skillEvolver.provider).toBe("gemini");
    expect(reloaded.config.skillEvolver.model).toBe("gemini-2.5-flash");
  });
});
