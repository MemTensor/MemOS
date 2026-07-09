import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { initLogger, shutdownLogger } from "../../../core/logger/index.js";
import { runSelfCheck } from "../../../core/logger/self-check.js";
import { makeTmpHome } from "../../helpers/tmp-home.js";

describe("logger/self-check", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await shutdownLogger();
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it("passes on a fresh tmp home and writes self-check.log", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    initLogger(ctx.config, ctx.home);

    const result = await runSelfCheck(ctx.home);
    expect(result.ok).toBe(true);
    expect(result.details.dispatcher).toBe(true);
    expect(result.details.logsDir).toBe(true);
    expect(result.details.audit).toBe(true);

    const trail = await fs.readFile(join(ctx.home.logsDir, "self-check.log"), "utf8");
    expect(trail).toContain("self-check");
  });
});
