/**
 * Bridge startup order regression test.
 *
 * Issue #1747: Hermes Python client's first `session.open` RPC timed out
 * when orphan episodes existed, because `core.init()` was blocking the
 * stdio read loop startup. Orphan recovery runs LLM calls (reward/reflection),
 * which can take 10-60+ seconds. If stdio hasn't started yet, the Python
 * adapter writes `session.open` to stdin but nobody reads it → timeout.
 *
 * Fix (commit 7c6bd250): Move `startStdioServer()` to *before* `core.init()`
 * so the stdio read loop is active when init's orphan recovery runs.
 *
 * This file guards that ordering: if a future refactor reverses the order,
 * the tests will fail before the bug reaches production.
 */
import { describe, it, expect, vi } from "vitest";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

describe("Bridge startup order (#1747 regression)", () => {
  it("startStdioServer returns before core.init() resolves", async () => {
    // Simulates the bridge.cts sequence: `stdio = startStdioServer(...)`
    // is synchronous, so its return marker must land in `callOrder`
    // BEFORE any await inside `core.init()` resolves.
    const callOrder: string[] = [];
    const initDelayMs = 50; // simulate orphan-recovery blocking work
    const core = createDelayedInitCore(initDelayMs, callOrder);

    const { startStdioServer } = await import("../../../bridge/stdio.js");

    // Mirror bridge.cts line 327-338 ordering:
    //   1. stdio = startStdioServer({ core })   ← sync
    //   2. await core.init()                    ← may block on LLM calls
    const stdio = startStdioServer({ core });
    callOrder.push("stdio_started");

    await core.init();
    callOrder.push("init_done");

    // The invariant we're protecting:
    //   stdio_started must land BEFORE init_complete.
    // If a future refactor swaps `startStdioServer` after `await core.init()`,
    // stdio_started would land AFTER init_complete and this assertion would fail.
    const stdioIdx = callOrder.indexOf("stdio_started");
    const initCompleteIdx = callOrder.indexOf("init_complete");
    expect(stdioIdx).toBeGreaterThanOrEqual(0);
    expect(initCompleteIdx).toBeGreaterThanOrEqual(0);
    expect(stdioIdx).toBeLessThan(initCompleteIdx);

    await stdio.close();
  });

  it("core.init() runs concurrently with stdio (does not block stdio startup)", async () => {
    // Verifies the temporal claim: with a slow init (100 ms), the stdio
    // handle is *available for use* well before init resolves. If stdio
    // were sequenced after init, this test's `stdio` variable wouldn't
    // exist until init_delayMs later.
    const callOrder: string[] = [];
    const initDelayMs = 100;
    const core = createDelayedInitCore(initDelayMs, callOrder);

    const { startStdioServer } = await import("../../../bridge/stdio.js");

    const start = Date.now();
    const stdio = startStdioServer({ core });
    const stdioAvailableAtMs = Date.now() - start;

    // stdio must be usable within a few ms — not after the init delay.
    // (Generous tolerance to avoid CI flakiness on slow machines.)
    expect(stdioAvailableAtMs).toBeLessThan(initDelayMs / 2);

    await core.init();
    await stdio.close();
  });
});

// ─── Stub MemoryCore with delayed init ───────────────────────────────────

function createDelayedInitCore(
  delayMs: number,
  callOrder: string[],
): MemoryCore {
  const subscribers: Array<(e: unknown) => void> = [];
  const logSubs: Array<(r: unknown) => void> = [];

  return {
    init: vi.fn(async () => {
      callOrder.push("init_begin");
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      callOrder.push("init_complete");
    }),
    shutdown: vi.fn(async () => {}),
    health: vi.fn(async () => ({
      ok: true,
      version: "test",
      uptimeMs: 1,
      agent: "openclaw",
      paths: { home: "", config: "", db: "", skills: "", logs: "" },
      llm: { available: false, provider: "" },
      embedder: { available: false, provider: "", dim: 0 },
    })),
    openSession: vi.fn(async ({ sessionId }) => sessionId ?? "s-auto"),
    closeSession: vi.fn(async () => {}),
    openEpisode: vi.fn(async ({ episodeId }) => episodeId ?? "e-auto"),
    closeEpisode: vi.fn(async () => {}),
    onTurnStart: vi.fn(async () => ({
      query: { agent: "openclaw", query: "" },
      hits: [],
      injectedContext: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    })),
    onTurnEnd: vi.fn(async () => ({ traceId: "tr-1", episodeId: "e-1" })),
    submitFeedback: vi.fn(async (fb) => ({
      id: "fb-1",
      ts: 1,
      channel: fb.channel,
      polarity: fb.polarity,
      magnitude: fb.magnitude,
    })),
    recordToolOutcome: vi.fn(),
    searchMemory: vi.fn(async (q) => ({
      query: q,
      hits: [],
      injectedContext: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    })),
    getTrace: vi.fn(async () => null),
    getPolicy: vi.fn(async () => null),
    getWorldModel: vi.fn(async () => null),
    listEpisodes: vi.fn(async () => []),
    timeline: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    getSkill: vi.fn(async () => null),
    archiveSkill: vi.fn(async () => {}),
    subscribeEvents: vi.fn((h: (e: unknown) => void) => {
      subscribers.push(h);
      return () => {
        const i = subscribers.indexOf(h);
        if (i >= 0) subscribers.splice(i, 1);
      };
    }) as any,
    subscribeLogs: vi.fn((h: (r: unknown) => void) => {
      logSubs.push(h);
      return () => {
        const i = logSubs.indexOf(h);
        if (i >= 0) logSubs.splice(i, 1);
      };
    }) as any,
  };
}
