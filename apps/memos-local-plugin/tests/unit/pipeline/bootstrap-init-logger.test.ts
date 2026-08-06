/**
 * Regression test for issue #2147:
 * The standalone bridge must request logger initialization after config is
 * resolved so file transports (memos.log, error.log, audit.log, llm.jsonl,
 * perf.jsonl, events.jsonl) are created on disk. Before the fix, the bridge
 * left the logger in `bootstrapConsoleOnly()` mode, so `home.logsDir` remained
 * empty even though `config.logging.file.enabled` defaults to `true`.
 *
 * The assertion is deliberately tight: emit a distinctive marker line
 * through `rootLogger.child(...)` after bootstrap, flush the logger, then
 * confirm the marker landed in `memos.log`. Any regression that leaves the
 * console-only sinks in place would make `memos.log` either missing or
 * marker-free.
 */

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { makeTmpHome, type TmpHomeContext } from "../../helpers/tmp-home.js";
import { bootstrapMemoryCoreFull } from "../../../core/pipeline/memory-core.js";
import {
  initTestLogger,
  rootLogger,
  shutdownLogger,
} from "../../../core/logger/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

describe("bootstrapMemoryCoreFull -> initLogger", () => {
  let home: TmpHomeContext | null = null;
  let core: MemoryCore | null = null;

  afterEach(async () => {
    if (core) await core.shutdown();
    await shutdownLogger();
    if (home) await home.cleanup();
    core = null;
    home = null;
    initTestLogger();
  });

  it("wires file transports when initLogging is set", async () => {
    home = await makeTmpHome({ agent: "openclaw" });

    // Sanity check: fixture leaves logsDir empty before bootstrap.
    const before = await fs.readdir(home.home.logsDir);
    expect(before).toEqual([]);

    const result = await bootstrapMemoryCoreFull({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "issue-2147-test",
      initLogging: true,
    });
    core = result.core;

    // Distinctive marker so we can grep memos.log without depending on
    // whichever config warnings bootstrap emitted.
    const marker = "issue-2147.marker.line.abcdef";
    rootLogger.child({ channel: "core.pipeline.bootstrap" }).info(marker, {
      probe: "bootstrap-init-logger",
    });
    await rootLogger.flush();

    const memosLogPath = join(home.home.logsDir, "memos.log");
    const stat = await fs.stat(memosLogPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);

    const text = await fs.readFile(memosLogPath, "utf8");
    expect(text).toContain(marker);
  });
});
