/**
 * Bootstrap logger initialization.
 *
 * The standalone daemon (`bridge.cts`) resolves config inside
 * `bootstrapMemoryCoreFull` but historically never called `initLogger`, so the
 * active logger stayed on the `bootstrapConsoleOnly()` default with `tz` pinned
 * to "UTC". That made `logging.timezone` (and the rest of the `logging.*`
 * block) inert in the daemon. These tests pin the opt-in wiring.
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeTmpHome, type TmpHomeContext } from "../../helpers/tmp-home.js";
import {
  initTestLogger,
  memoryBuffer,
  rootLogger,
} from "../../../core/logger/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

describe("bootstrapMemoryCoreFull logger init", () => {
  let home: TmpHomeContext | null = null;
  let core: MemoryCore | null = null;

  afterEach(async () => {
    if (core) await core.shutdown();
    if (home) await home.cleanup();
    core = null;
    home = null;
    initTestLogger();
  });

  it("initializes the active logger from config when initLogging is set", async () => {
    const { bootstrapMemoryCoreFull } = await import(
      "../../../core/pipeline/memory-core.js"
    );
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: `
logging:
  timezone: America/Los_Angeles
`,
    });

    const result = await bootstrapMemoryCoreFull({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "bootstrap-test",
      initLogging: true,
    });
    core = result.core;

    rootLogger.child({ channel: "core.session" }).info("bootstrap.tz");
    await rootLogger.flush();

    expect(memoryBuffer().tail({ limit: 1 }).at(0)?.tz).toBe(
      "America/Los_Angeles",
    );
  });

  it("leaves the logger untouched when initLogging is not requested", async () => {
    const { bootstrapMemoryCoreFull } = await import(
      "../../../core/pipeline/memory-core.js"
    );
    home = await makeTmpHome({
      agent: "openclaw",
      configYaml: `
logging:
  timezone: America/Los_Angeles
`,
    });

    const result = await bootstrapMemoryCoreFull({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "bootstrap-test",
    });
    core = result.core;

    rootLogger.child({ channel: "core.session" }).info("bootstrap.default");
    await rootLogger.flush();

    // Embedded-plugin path: host owns logging, so the default UTC logger stays.
    expect(memoryBuffer().tail({ limit: 1 }).at(0)?.tz).toBe("UTC");
  });
});
