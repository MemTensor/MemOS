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
    // `viewer.port` is adapter-owned and silently stripped from patches
    // (see #2212), so pick a still-validated field for the schema check.
    await expect(patchConfig(ctx.home, { bridge: { port: -3 } as Record<string, unknown> }))
      .rejects.toThrow(/schema validation/);
  });

  it("subsequent loadConfig sees the patched values", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    await patchConfig(ctx.home, { algorithm: { skill: { minSupport: 7 } } });
    const reloaded = await loadConfig(ctx.home);
    expect(reloaded.config.algorithm.skill.minSupport).toBe(7);
  });

  it("patches lightweight memory mode without disturbing other algorithm fields", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    await patchConfig(ctx.home, {
      algorithm: { lightweightMemory: { enabled: true } },
    });
    const reloaded = await loadConfig(ctx.home);
    expect(reloaded.config.algorithm.lightweightMemory.enabled).toBe(true);
    expect(reloaded.config.algorithm.skill.minSupport).toBeGreaterThan(0);
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

  /**
   * Regression: #2212. On Hermes the viewer daemon is hardcoded to :18800
   * (see bridge.mts::AGENT_DEFAULT_PORTS), but the shared UI default in
   * defaults.ts is :18799 (the OpenClaw port). A PATCH body that carries
   * `viewer.port: 18799` — from a viewer form that rehydrated the
   * cross-agent default, or from any third-party client that mirrors GET
   * back into PATCH — used to be written to disk verbatim, silently
   * corrupting the Hermes config so the bridge could not find the viewer
   * on next start. The writer must protect the fixed `viewer.port` while
   * leaving other viewer settings patchable.
   */
  it("ignores viewer.port in the incoming patch to protect adapter ownership", async () => {
    const original = `viewer:
  port: 18800
  bindHost: 127.0.0.1
llm:
  provider: openai_compatible
`;
    const ctx = await makeTmpHome({ agent: "hermes", configYaml: original });
    cleanup = ctx.cleanup;

    await patchConfig(ctx.home, {
      viewer: { port: 18799 },
      llm: { temperature: 0.4 },
    });

    const reloaded = await loadConfig(ctx.home);
    // viewer.port must survive untouched — the adapter owns it.
    expect(reloaded.config.viewer.port).toBe(18800);
    // Sibling patches still land normally.
    expect(reloaded.config.llm.temperature).toBe(0.4);
    // On-disk YAML must not contain the rejected 18799 value under viewer.
    const text = await fs.readFile(ctx.home.configFile, "utf8");
    expect(text).not.toMatch(/port:\s*18799/);
    expect(text).toMatch(/port:\s*18800/);
  });

  it("allows patching viewer.bindHost because the server honors it", async () => {
    const original = `viewer:
  port: 18800
  bindHost: 127.0.0.1
`;
    const ctx = await makeTmpHome({ agent: "hermes", configYaml: original });
    cleanup = ctx.cleanup;

    await patchConfig(ctx.home, {
      viewer: { bindHost: "0.0.0.0" },
    });

    const reloaded = await loadConfig(ctx.home);
    expect(reloaded.config.viewer.bindHost).toBe("0.0.0.0");
    const text = await fs.readFile(ctx.home.configFile, "utf8");
    expect(text).toMatch(/bindHost:\s*0\.0\.0\.0/);
  });

  /**
   * viewer.openOnFirstTurn is an actual user-facing preference (the UI
   * exposes it via the settings page), so it must remain patchable even
   * though it sits under the same `viewer:` map as the adapter-owned port.
   */
  it("still allows patching non-adapter viewer fields (openOnFirstTurn)", async () => {
    const original = `viewer:
  port: 18800
  bindHost: 127.0.0.1
  openOnFirstTurn: false
`;
    const ctx = await makeTmpHome({ agent: "hermes", configYaml: original });
    cleanup = ctx.cleanup;

    await patchConfig(ctx.home, {
      viewer: { openOnFirstTurn: true, port: 18799 },
    });

    const reloaded = await loadConfig(ctx.home);
    expect(reloaded.config.viewer.openOnFirstTurn).toBe(true);
    expect(reloaded.config.viewer.port).toBe(18800);
  });

  /** Empty means "use the provider default" and must remain patchable. */
  it("allows clearing embedding.endpoint to restore the provider default", async () => {
    const original = `embedding:
  provider: openai_compatible
  endpoint: "https://api.openai.com/v1"
  model: text-embedding-3-small
  apiKey: "sk-existing"
`;
    const ctx = await makeTmpHome({ agent: "hermes", configYaml: original });
    cleanup = ctx.cleanup;

    await patchConfig(ctx.home, {
      embedding: { endpoint: "" },
    });

    const reloaded = await loadConfig(ctx.home);
    expect(reloaded.config.embedding.endpoint).toBe("");
    const text = await fs.readFile(ctx.home.configFile, "utf8");
    expect(text).toMatch(/endpoint:\s*""/);
  });

  /**
   * A non-empty whitespace-only string is never a usable endpoint. Ignore
   * that accidental form value without conflating it with the valid empty
   * reset above.
   */
  it("does not overwrite endpoint fields with whitespace-only patches", async () => {
    const original = `embedding:
  provider: openai_compatible
  endpoint: "https://api.openai.com/v1"
llm:
  provider: openai_compatible
  endpoint: "https://api.openai.com/v1"
`;
    const ctx = await makeTmpHome({ agent: "hermes", configYaml: original });
    cleanup = ctx.cleanup;

    await patchConfig(ctx.home, {
      embedding: { endpoint: "   " },
      llm: { endpoint: "\t\n" },
    });

    const reloaded = await loadConfig(ctx.home);
    expect(reloaded.config.embedding.endpoint).toBe("https://api.openai.com/v1");
    expect(reloaded.config.llm.endpoint).toBe("https://api.openai.com/v1");
  });

  /**
   * Regression: the sanitiser used to clone the patch via
   * `JSON.parse(JSON.stringify(...))`, which silently deletes keys whose
   * value is `undefined`. A caller that legitimately passes
   * `{ llm: { temperature: undefined } }` (e.g. a form that meant to unset
   * the override, or a mis-serialised client payload) would have that leaf
   * disappear before `applyPatch` could act on it, meaning the writer
   * would silently no-op instead of surfacing the invalid state. Switching
   * to `structuredClone` preserves the full object graph so the schema
   * validator sees the invalid leaf and rejects the patch, giving the
   * caller a clear error instead of silent success.
   */
  it("preserves undefined leaves in the patch (structured-clone semantics)", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;

    // Old JSON-clone behaviour: `undefined` dropped, patch becomes
    // `{ llm: {} }`, applyPatch no-ops, schema passes → test would pass.
    // New structuredClone behaviour: `undefined` survives, applyPatch
    // calls `doc.setIn(['llm','temperature'], undefined)` which writes a
    // null scalar, schema then rejects "Expected number" → this assertion
    // captures the shift.
    await expect(
      patchConfig(ctx.home, {
        llm: { temperature: undefined } as Record<string, unknown>,
      }),
    ).rejects.toThrow(/schema validation/);
  });
});
