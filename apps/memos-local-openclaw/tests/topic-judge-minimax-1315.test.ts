/**
 * Regression test for issue #1315:
 * Topic Judge 100% failure rate against MiniMax (api.minimaxi.com) because
 * judgeNewTopicOpenAI / arbitrateTopicSplitOpenAI request max_tokens: 10,
 * which MiniMax's gateway rejects with an HTML 404 page.
 *
 * The fix raises the minimum to 60 (matching classifyTopicOpenAI in the same
 * file, which is already proven to work against MiniMax). These tests assert
 * the on-the-wire request body uses at least 60 max_tokens for the two
 * affected helpers; if anyone lowers them back to 10 the tests fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  judgeNewTopicOpenAI,
  arbitrateTopicSplitOpenAI,
  classifyTopicOpenAI,
  filterRelevantOpenAI,
  judgeDedupOpenAI,
  summarizeOpenAI,
} from "../src/ingest/providers/openai";
import type { SummarizerConfig, Logger } from "../src/types";

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const minimaxCfg: SummarizerConfig = {
  provider: "openai_compatible",
  model: "MiniMax-M2.7-highspeed",
  endpoint: "https://api.minimaxi.com/v1",
  apiKey: "test-key",
};

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Replace global.fetch with a recorder that returns a canned successful
 * completion. Returns the captured-requests array so tests can assert on
 * url / body / max_tokens.
 */
function installFetchRecorder(replyContent: string): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    captured.push({ url: String(url), body });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: replyContent } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fakeFetch);
  return captured;
}

describe("openai topic-judge max_tokens regression (issue #1315)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("judgeNewTopicOpenAI sends max_tokens >= 60 (MiniMax rejects max_tokens: 10 with HTML 404)", async () => {
    const captured = installFetchRecorder("SAME");

    await judgeNewTopicOpenAI("current task context", "new user message", minimaxCfg, silentLog);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://api.minimaxi.com/v1/chat/completions");
    const maxTokens = captured[0].body.max_tokens as number;
    expect(maxTokens).toBeGreaterThanOrEqual(60);
  });

  it("arbitrateTopicSplitOpenAI sends max_tokens >= 60 (same MiniMax 404 gateway behaviour)", async () => {
    const captured = installFetchRecorder("NEW");

    await arbitrateTopicSplitOpenAI("task state", "new message", minimaxCfg, silentLog);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://api.minimaxi.com/v1/chat/completions");
    const maxTokens = captured[0].body.max_tokens as number;
    expect(maxTokens).toBeGreaterThanOrEqual(60);
  });

  it("judgeNewTopicOpenAI still parses single-word NEW / SAME replies after the bump", async () => {
    installFetchRecorder("NEW");
    const isNew = await judgeNewTopicOpenAI("ctx", "msg", minimaxCfg, silentLog);
    expect(isNew).toBe(true);

    installFetchRecorder("SAME");
    const isSame = await judgeNewTopicOpenAI("ctx", "msg", minimaxCfg, silentLog);
    expect(isSame).toBe(false);
  });

  it("arbitrateTopicSplitOpenAI still normalises replies to NEW or SAME after the bump", async () => {
    installFetchRecorder("NEW\n");
    expect(await arbitrateTopicSplitOpenAI("task", "msg", minimaxCfg, silentLog)).toBe("NEW");

    installFetchRecorder("same");
    expect(await arbitrateTopicSplitOpenAI("task", "msg", minimaxCfg, silentLog)).toBe("SAME");
  });

  it("other openai helpers keep their existing max_tokens limits (no regression on healthy callers)", async () => {
    const a = installFetchRecorder("60");
    await classifyTopicOpenAI("task", "msg", minimaxCfg, silentLog);
    // classifyTopic was already 60 — should remain at least 60.
    expect(a[0].body.max_tokens as number).toBeGreaterThanOrEqual(60);

    const b = installFetchRecorder('{"relevant":[],"sufficient":false}');
    await filterRelevantOpenAI("q", [{ index: 1, role: "user", content: "c" }], minimaxCfg, silentLog);
    expect(b[0].body.max_tokens as number).toBeGreaterThanOrEqual(200);

    const c = installFetchRecorder('{"action":"NEW","reason":""}');
    await judgeDedupOpenAI("new", [{ index: 1, summary: "s", chunkId: "x" }], minimaxCfg, silentLog);
    expect(c[0].body.max_tokens as number).toBeGreaterThanOrEqual(300);

    const d = installFetchRecorder("hello world summary");
    await summarizeOpenAI("input text", minimaxCfg, silentLog);
    // summarize does not set max_tokens (server default) — assert the field is absent / unset.
    expect(d[0].body.max_tokens).toBeUndefined();
  });
});
