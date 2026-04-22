/**
 * End-to-end dispatch tests: emit through the real `rootLogger` after
 * `initLogger` and assert the outcome via `memoryBuffer().tail()` plus the
 * actual files on disk.
 *
 * We intentionally use `tmp-home` so files land in a throwaway dir.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { initLogger, memoryBuffer, rootLogger, shutdownLogger } from "../../../core/logger/index.js";
import { onBroadcastLog } from "../../../core/logger/transports/sse-broadcast.js";
import { withCtx } from "../../../core/logger/context.js";
import { makeTmpHome } from "../../helpers/tmp-home.js";

describe("logger/dispatch", () => {
  let cleanup: (() => Promise<void>) | null = null;
  beforeEach(() => { /* no-op */ });
  afterEach(async () => {
    await shutdownLogger();
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it("writes app records to memos.log + memory buffer + SSE broadcast", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    initLogger(ctx.config, ctx.home, { broadcastEnabled: true });

    const seen: string[] = [];
    const off = onBroadcastLog((r) => seen.push(r.msg));

    const log = rootLogger.child({ channel: "core.session" });
    log.info("session.opened", { sessionId: "se_test" });

    off();
    await rootLogger.flush();

    expect(memoryBuffer().tail({ limit: 1 }).at(0)?.msg).toBe("session.opened");
    expect(seen).toContain("session.opened");

    const text = await fs.readFile(join(ctx.home.logsDir, "memos.log"), "utf8");
    expect(text).toContain("session.opened");
    expect(text).toContain("se_test");
  });

  it("respects per-channel level overrides", async () => {
    const yaml = `
logging:
  level: warn
  channels:
    "core.skill": debug
    "core.skill.crystallize": trace
`;
    const ctx = await makeTmpHome({ agent: "openclaw", configYaml: yaml });
    cleanup = ctx.cleanup;
    initLogger(ctx.config, ctx.home);

    const a = rootLogger.child({ channel: "core.session" });
    const b = rootLogger.child({ channel: "core.skill.crystallize" });

    a.info("dropped");                  // global=warn, channel=info → dropped
    b.trace("kept");                    // override=trace → kept
    await rootLogger.flush();

    const tail = memoryBuffer().tail({ limit: 50 });
    expect(tail.find((r) => r.msg === "dropped")).toBeUndefined();
    expect(tail.find((r) => r.msg === "kept")).toBeDefined();
  });

  it("writes audit records to audit.log (永不删除 mode = forever)", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    initLogger(ctx.config, ctx.home);

    rootLogger.child({ channel: "system" }).audit("plugin.installed", { version: "2.0.0-alpha.1" });
    await rootLogger.flush();

    const text = await fs.readFile(join(ctx.home.logsDir, "audit.log"), "utf8");
    expect(text).toContain("plugin.installed");
    expect(text).toContain("2.0.0-alpha.1");
  });

  it("redacts secret fields before writing anywhere", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    initLogger(ctx.config, ctx.home);

    rootLogger.child({ channel: "llm.openai" }).info("call", {
      provider: "openai_compatible",
      api_key: "sk-DO_NOT_LEAK",
      prompt: "hello",
    });
    await rootLogger.flush();

    const text = await fs.readFile(join(ctx.home.logsDir, "memos.log"), "utf8");
    expect(text).not.toContain("sk-DO_NOT_LEAK");
    expect(text).toContain("[redacted]");
  });

  it("attaches ambient ctx (sessionId / traceId) automatically", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    initLogger(ctx.config, ctx.home);

    const log = rootLogger.child({ channel: "core.session" });
    await withCtx({ sessionId: "se_ambient", traceId: "tr_ambient" }, async () => {
      log.info("inside");
    });
    await rootLogger.flush();

    const last = memoryBuffer().tail({ limit: 1 }).at(0)!;
    expect(last.ctx?.sessionId).toBe("se_ambient");
    expect(last.ctx?.traceId).toBe("tr_ambient");
  });

  it("logger.timer emits a perf record on disposal", async () => {
    const ctx = await makeTmpHome({ agent: "openclaw" });
    cleanup = ctx.cleanup;
    initLogger(ctx.config, ctx.home);

    const log = rootLogger.child({ channel: "core.retrieval.tier1" });
    {
      using span = log.timer("tier1.search");
      void span;
    }
    await rootLogger.flush();

    const perfPath = join(ctx.home.logsDir, "perf.jsonl");
    const text = await fs.readFile(perfPath, "utf8");
    expect(text).toContain("tier1.search");
    expect(text).toContain("\"kind\":\"perf\"");
  });

  it("forward() bypasses level gate (used by Hermes Python forwarder)", async () => {
    const yaml = `
logging:
  level: error
`;
    const ctx = await makeTmpHome({ agent: "openclaw", configYaml: yaml });
    cleanup = ctx.cleanup;
    initLogger(ctx.config, ctx.home);

    rootLogger.child({ channel: "adapter.hermes" }).forward({
      ts: Date.now(),
      level: "info",
      kind: "app",
      channel: "adapter.hermes",
      msg: "py.heartbeat",
      data: { ok: true },
      src: "py",
    });
    await rootLogger.flush();
    expect(memoryBuffer().tail({ limit: 1 }).at(0)?.msg).toBe("py.heartbeat");
  });
});
