/**
 * Regression test for issue #1596:
 * "System overview doesn't show the correct configuration value for model".
 *
 * The viewer's Overview cards render the configured model for three
 * slots — Embedding, Summarizer (= `llm`), and Skill Evolver — using
 * the `model` field returned by `MemoryCore.health()`. The contract:
 * whatever the user just saved in Settings (i.e. what's on disk in
 * `config.yaml`) must be the value shown on Overview, even when an
 * earlier provider/model is still cached in-memory.
 *
 * Three failure modes the old `health()` code did not cover:
 *
 *  1. Only `model` was overridden from disk when it differed from the
 *     in-memory client. If the user changed only `provider` (keeping
 *     the same model name), Overview kept showing the old provider.
 *  2. If the user **cleared** a model name in Settings, the old code
 *     skipped the override (truthy guard) and Overview kept showing
 *     the previously-configured value.
 *  3. The skill evolver in inherited mode (`skillEvolver.model = ""`)
 *     read the in-memory `llm.model` directly via `resolveSkillEvolver`,
 *     so it lagged behind disk after a Settings change.
 *
 * These tests pin the contract: Overview always reflects disk config
 * for the three slots' `model` + `provider` display values.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapMemoryCore } from "../../../core/pipeline/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { __resetHostLlmBridgeForTests } from "../../../core/llm/index.js";
import { makeTmpHome, type TmpHomeContext } from "../../helpers/tmp-home.js";

let home: TmpHomeContext | null = null;
let core: MemoryCore | null = null;

beforeEach(() => {
  /* fresh per test */
});

afterEach(async () => {
  if (core) {
    try { await core.shutdown(); } catch { /* ignore */ }
    core = null;
  }
  if (home) {
    await home.cleanup();
    home = null;
  }
  __resetHostLlmBridgeForTests();
});

describe("health() — Overview model display reflects disk config (#1596)", () => {
  it("returns the embedding/llm/skillEvolver model names exactly as saved on disk", async () => {
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: `
version: 1
embedding:
  provider: openai_compatible
  endpoint: https://example.test/v1
  model: text-embedding-3-small
  apiKey: sk-test-emb
llm:
  provider: openai_compatible
  endpoint: https://example.test/v1
  model: gpt-4o-mini
  apiKey: sk-test-llm
skillEvolver:
  provider: anthropic
  endpoint: https://example.test
  model: claude-sonnet-4
  apiKey: sk-test-skill
algorithm:
  lightweightMemory:
    enabled: false
`,
    });
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "test-1.0.0",
    });
    await core.init();

    const h = await core.health();

    expect(h.embedder?.model).toBe("text-embedding-3-small");
    expect(h.embedder?.provider).toBe("openai_compatible");

    expect(h.llm?.model).toBe("gpt-4o-mini");
    expect(h.llm?.provider).toBe("openai_compatible");

    expect(h.skillEvolver?.model).toBe("claude-sonnet-4");
    expect(h.skillEvolver?.provider).toBe("anthropic");
    expect(h.skillEvolver?.inherited).toBe(false);
  });

  it("when skillEvolver has no own model, inherits from llm and shows llm's disk model", async () => {
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: `
version: 1
llm:
  provider: openai_compatible
  endpoint: https://example.test/v1
  model: gpt-4o-mini
  apiKey: sk-test-llm
skillEvolver:
  provider: ""
  model: ""
`,
    });
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "test-1.0.0",
    });
    await core.init();

    const h = await core.health();

    expect(h.llm?.model).toBe("gpt-4o-mini");
    expect(h.skillEvolver?.inherited).toBe(true);
    // Inherited skillEvolver MUST show the same llm model as the
    // Overview's main LLM card — anything else looks like the
    // Overview is out of sync with the configuration.
    expect(h.skillEvolver?.model).toBe("gpt-4o-mini");
    expect(h.skillEvolver?.provider).toBe("openai_compatible");
  });

  it("reflects disk changes after the user saves new model+provider in Settings (no restart yet)", async () => {
    // Boot with one config, then mutate the on-disk config.yaml to
    // simulate the user hitting "Save" in Settings without restarting.
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: `
version: 1
embedding:
  provider: openai_compatible
  endpoint: https://example.test/v1
  model: text-embedding-3-small
  apiKey: sk-test-old
llm:
  provider: openai_compatible
  endpoint: https://example.test/v1
  model: gpt-4o-mini
  apiKey: sk-test-old
`,
    });
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "test-1.0.0",
    });
    await core.init();

    // User saves new settings — provider and model both change.
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      home.home.configFile,
      `
version: 1
embedding:
  provider: gemini
  endpoint: https://example.test/v1beta
  model: text-embedding-004
  apiKey: sk-test-new
llm:
  provider: anthropic
  endpoint: https://example.test
  model: claude-sonnet-4
  apiKey: sk-test-new
`,
      "utf8",
    );

    const h = await core.health();

    // The in-memory client still has the OLD model (no restart), but
    // Overview MUST reflect what the user just saved.
    expect(h.embedder?.model).toBe("text-embedding-004");
    expect(h.embedder?.provider).toBe("gemini");
    expect(h.llm?.model).toBe("claude-sonnet-4");
    expect(h.llm?.provider).toBe("anthropic");
  });

  it("when the user changes only the provider (model name unchanged), Overview reflects the new provider", async () => {
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: `
version: 1
embedding:
  provider: openai_compatible
  endpoint: https://example.test/v1
  model: shared-embed-model
  apiKey: sk-test
llm:
  provider: openai_compatible
  endpoint: https://example.test/v1
  model: shared-model-name
  apiKey: sk-test
`,
    });
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "test-1.0.0",
    });
    await core.init();

    // Same model name, different provider — for both embedding + llm.
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      home.home.configFile,
      `
version: 1
embedding:
  provider: gemini
  endpoint: https://example.test/v1beta
  model: shared-embed-model
  apiKey: sk-test
llm:
  provider: anthropic
  endpoint: https://example.test
  model: shared-model-name
  apiKey: sk-test
`,
      "utf8",
    );

    const h = await core.health();
    expect(h.llm?.model).toBe("shared-model-name");
    expect(h.embedder?.model).toBe("shared-embed-model");
    // These used to fail: the old code only updated provider if model
    // also differed, so the provider stayed on "openai_compatible".
    expect(h.llm?.provider).toBe("anthropic");
    expect(h.embedder?.provider).toBe("gemini");
  });

  /**
   * Regression test for issue #2380:
   * findLatestPersistedModelStatus previously fetched the newest 500
   * api_logs rows and post-filtered in JS. On busy installs the target
   * slot's row is pushed >500 positions below the head by high-frequency
   * llm/embedding writes, so the lookup silently returned null and the
   * Overview card read "Not called yet" even though rows existed.
   *
   * The fix uses json_extract() in SQL so the query is not bounded by any
   * top-N window.
   */
  it("finds skillEvolver status row even when >500 higher-frequency rows follow it (#2380)", async () => {
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: `
version: 1
llm:
  provider: openai_compatible
  endpoint: https://example.test/v1
  model: gpt-4o-mini
  apiKey: sk-test
skillEvolver:
  provider: anthropic
  endpoint: https://example.test
  model: claude-skill-evolver-test
  apiKey: sk-test-skill
algorithm:
  lightweightMemory:
    enabled: false
`,
    });

    // Phase 1: run migrations so the DB file and schema exist, then shut down
    // cleanly so we can seed rows via a second SQLite connection.
    const seeder = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "seed-2380",
    });
    await seeder.init();
    await seeder.shutdown();

    // Phase 2: seed rows directly — one skillEvolver "ok" row followed by
    // 600 llm rows. After this the skillEvolver row sits 600 positions below
    // the table head, well outside the old 500-row scan window.
    const Sqlite = (await import("better-sqlite3")).default;
    const seedDb = new Sqlite(home.home.dbFile);
    const now = 1_700_000_000_000;

    const insertRow = seedDb.prepare(
      `INSERT INTO api_logs (tool_name, input_json, output_json, duration_ms, success, called_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    insertRow.run(
      "system_model_status",
      "{}",
      JSON.stringify({
        role: "skillEvolver",
        provider: "anthropic",
        model: "claude-skill-evolver-test",
        status: "ok",
      }),
      10,
      1,
      now,
    );

    for (let i = 1; i <= 600; i++) {
      insertRow.run(
        "system_model_status",
        "{}",
        JSON.stringify({
          role: "llm",
          provider: "openai_compatible",
          model: "gpt-4o-mini",
          status: "ok",
        }),
        10,
        1,
        now + i,
      );
    }

    seedDb.close();

    // Phase 3: boot the real core and verify health() surfaces the seeded row.
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "check-2380",
    });
    await core.init();

    const h = await core.health();

    // Before the fix this was null because the skillEvolver row was outside
    // the 500-row scan window; with json_extract() filtering it is always found.
    expect(h.skillEvolver?.lastOkAt).toBe(now);
  });

  it("inherited skillEvolver reflects mid-flight llm changes (no restart yet)", async () => {
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: `
version: 1
llm:
  provider: openai_compatible
  endpoint: https://example.test/v1
  model: original-llm-model
  apiKey: sk-test
skillEvolver:
  provider: ""
  model: ""
`,
    });
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "test-1.0.0",
    });
    await core.init();

    // User saves new llm settings; skillEvolver still inherits.
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      home.home.configFile,
      `
version: 1
llm:
  provider: anthropic
  endpoint: https://example.test
  model: changed-llm-model
  apiKey: sk-test
skillEvolver:
  provider: ""
  model: ""
`,
      "utf8",
    );

    const h = await core.health();
    // Sanity: llm slot reflects the new disk values.
    expect(h.llm?.model).toBe("changed-llm-model");
    expect(h.llm?.provider).toBe("anthropic");
    // The inherited skillEvolver MUST mirror the llm slot — anything
    // else looks broken to the operator (Overview's three model cards
    // get out of sync).
    expect(h.skillEvolver?.inherited).toBe(true);
    expect(h.skillEvolver?.model).toBe("changed-llm-model");
    expect(h.skillEvolver?.provider).toBe("anthropic");
  });
});
