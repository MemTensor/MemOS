/**
 * Regression test for issue #1611:
 *
 * `Summarizer.classifyTopic` and `Summarizer.arbitrateTopicSplit` used to
 * dispatch to the OpenAI implementation for EVERY provider — including
 * `anthropic`, `gemini`, and `bedrock` — because their case arms in the
 * `callTopicClassifier` / `callTopicArbitration` switch statements silently
 * fell through to `classifyTopicOpenAI` / `arbitrateTopicSplitOpenAI`.
 *
 * That broke summarizers configured against Anthropic-only endpoints (e.g.
 * Kimi Code's `/coding/v1/messages`), where the OpenAI helper's
 * `/chat/completions` URL simply doesn't exist and every call 404'd.
 *
 * These tests stub `globalThis.fetch` and assert that each provider hits the
 * transport-appropriate URL with a body shape the target API actually
 * accepts. A regression that routed `anthropic` back through the OpenAI
 * transport would either hit `/chat/completions` (wrong URL) or emit an
 * `OpenAI topic-classifier failed` error string (wrong label) — both are
 * asserted below.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Summarizer } from "../src/ingest/providers";
import type { SummarizerConfig, Logger } from "../src/types";

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Replace global.fetch with a recorder. Each invocation returns a canned
 * successful response whose shape matches `provider`.
 */
function installFetchRecorder(
  provider: "openai" | "anthropic" | "gemini" | "bedrock",
  replyText: string,
): CapturedRequest[] {
  const captured: CapturedRequest[] = [];

  const buildResponse = () => {
    switch (provider) {
      case "openai":
        return { choices: [{ message: { content: replyText } }] };
      case "anthropic":
        return { content: [{ type: "text", text: replyText }] };
      case "gemini":
        return { candidates: [{ content: { parts: [{ text: replyText }] } }] };
      case "bedrock":
        return { output: { message: { content: [{ text: replyText }] } } };
    }
  };

  const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = String(v);
    }
    captured.push({ url: String(url), headers, body });
    return new Response(JSON.stringify(buildResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  vi.stubGlobal("fetch", fakeFetch);
  return captured;
}

function installErrorFetch(status: number, errorBody: string): void {
  const fakeFetch = vi.fn(async () =>
    new Response(errorBody, { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fakeFetch);
}

describe("classifyTopic / arbitrateTopicSplit dispatch by provider (issue #1611)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("openai_compatible → POSTs /chat/completions with system+user messages", async () => {
    const captured = installFetchRecorder("openai", '{"d":"S","c":0.9}');
    const cfg: SummarizerConfig = {
      provider: "openai_compatible",
      endpoint: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "test-model",
    };
    const sum = new Summarizer(cfg, silentLog);

    const result = await sum.classifyTopic("task state", "new msg");
    expect(result?.decision).toBe("SAME");

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://api.example.com/v1/chat/completions");
    expect(captured[0].headers.Authorization).toBe("Bearer sk-test");
    const msgs = captured[0].body.messages as Array<{ role: string; content: string }>;
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("Classify if NEW MESSAGE");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("TASK:\ntask state");
  });

  it("anthropic → POSTs /v1/messages with x-api-key and system prompt (regression: was hitting /chat/completions)", async () => {
    const captured = installFetchRecorder("anthropic", '{"d":"N","c":0.85}');
    const cfg: SummarizerConfig = {
      provider: "anthropic",
      endpoint: "https://api.kimi.com/coding/v1/messages",
      apiKey: "kimi-test",
      model: "kimi-for-coding",
    };
    const sum = new Summarizer(cfg, silentLog);

    const result = await sum.classifyTopic("task state", "new msg");
    expect(result?.decision).toBe("NEW");
    expect(result?.confidence).toBeCloseTo(0.85);

    expect(captured).toHaveLength(1);
    // Must NOT contain /chat/completions — that's the pre-fix bug.
    expect(captured[0].url).not.toContain("/chat/completions");
    expect(captured[0].url).toBe("https://api.kimi.com/coding/v1/messages");
    expect(captured[0].headers["x-api-key"]).toBe("kimi-test");
    expect(captured[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured[0].body.system).toContain("Classify if NEW MESSAGE");
    expect(captured[0].body.model).toBe("kimi-for-coding");
    const anthropicMessages = captured[0].body.messages as Array<{ role: string; content: string }>;
    expect(anthropicMessages[0].role).toBe("user");
    expect(anthropicMessages[0].content).toContain("TASK:\ntask state");
  });

  it("gemini → POSTs :generateContent with systemInstruction and apiKey query param", async () => {
    const captured = installFetchRecorder("gemini", '{"d":"S","c":0.7}');
    const cfg: SummarizerConfig = {
      provider: "gemini",
      apiKey: "gemini-test",
      model: "gemini-1.5-flash",
    };
    const sum = new Summarizer(cfg, silentLog);

    const result = await sum.classifyTopic("task state", "new msg");
    expect(result?.decision).toBe("SAME");

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain(":generateContent?key=gemini-test");
    expect(captured[0].url).toContain("gemini-1.5-flash");
    // Body must use Gemini's structured shape, not OpenAI's.
    expect(captured[0].body.messages).toBeUndefined();
    const sysInstr = captured[0].body.systemInstruction as { parts: Array<{ text: string }> };
    expect(sysInstr.parts[0].text).toContain("Classify if NEW MESSAGE");
    const contents = captured[0].body.contents as Array<{ parts: Array<{ text: string }> }>;
    expect(contents[0].parts[0].text).toContain("TASK:\ntask state");
  });

  it("bedrock → POSTs /model/<model>/converse with system[] and messages[]", async () => {
    const captured = installFetchRecorder("bedrock", '{"d":"N","c":0.6}');
    const cfg: SummarizerConfig = {
      provider: "bedrock",
      endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKey: "aws-test",
      model: "anthropic.claude-3-haiku-20240307-v1:0",
    };
    const sum = new Summarizer(cfg, silentLog);

    const result = await sum.classifyTopic("task state", "new msg");
    expect(result?.decision).toBe("NEW");

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-haiku-20240307-v1:0/converse",
    );
    // Body must use Bedrock Converse shape.
    expect(captured[0].body.choices).toBeUndefined();
    const system = captured[0].body.system as Array<{ text: string }>;
    expect(system[0].text).toContain("Classify if NEW MESSAGE");
    const bedrockMessages = captured[0].body.messages as Array<{ role: string; content: Array<{ text: string }> }>;
    expect(bedrockMessages[0].role).toBe("user");
    expect(bedrockMessages[0].content[0].text).toContain("TASK:\ntask state");
  });

  it("arbitrateTopicSplit for anthropic → POSTs /v1/messages, returns NEW/SAME", async () => {
    const captured = installFetchRecorder("anthropic", "NEW");
    const cfg: SummarizerConfig = {
      provider: "anthropic",
      endpoint: "https://api.kimi.com/coding/v1/messages",
      apiKey: "kimi-test",
      model: "kimi-for-coding",
    };
    const sum = new Summarizer(cfg, silentLog);

    const result = await sum.arbitrateTopicSplit("task", "msg");
    expect(result).toBe("NEW");
    expect(captured[0].url).toBe("https://api.kimi.com/coding/v1/messages");
    expect(captured[0].body.system).toContain("A classifier flagged this message");
  });

  it("arbitrateTopicSplit for gemini → POSTs :generateContent, returns SAME on non-NEW reply", async () => {
    const captured = installFetchRecorder("gemini", "same");
    const cfg: SummarizerConfig = {
      provider: "gemini",
      apiKey: "gemini-test",
      model: "gemini-1.5-flash",
    };
    const sum = new Summarizer(cfg, silentLog);

    const result = await sum.arbitrateTopicSplit("task", "msg");
    expect(result).toBe("SAME");
    expect(captured[0].url).toContain(":generateContent?key=gemini-test");
  });

  it("arbitrateTopicSplit for bedrock → POSTs /converse, uses system[] shape", async () => {
    const captured = installFetchRecorder("bedrock", "NEW\n");
    const cfg: SummarizerConfig = {
      provider: "bedrock",
      endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKey: "aws-test",
      model: "anthropic.claude-3-haiku-20240307-v1:0",
    };
    const sum = new Summarizer(cfg, silentLog);

    const result = await sum.arbitrateTopicSplit("task", "msg");
    expect(result).toBe("NEW");
    expect(captured[0].url).toContain("/model/anthropic.claude-3-haiku-20240307-v1:0/converse");
    const bsystem = captured[0].body.system as Array<{ text: string }>;
    expect(bsystem[0].text).toContain("A classifier flagged this message");
  });

  it("anthropic 404 surfaces as 'Anthropic topic-classifier failed', not 'OpenAI' — the actual issue #1611 signature", async () => {
    installErrorFetch(
      404,
      '{"error":{"message":"The requested resource was not found","type":"resource_not_found_error"}}',
    );
    const errorMessages: string[] = [];
    const captureLog: Logger = {
      debug: () => {},
      info: () => {},
      warn: (m) => errorMessages.push(m),
      error: (m) => errorMessages.push(m),
    };
    const cfg: SummarizerConfig = {
      provider: "anthropic",
      endpoint: "https://api.kimi.com/coding/v1/messages",
      apiKey: "kimi-test",
      model: "kimi-for-coding",
    };
    const sum = new Summarizer(cfg, captureLog);

    const result = await sum.classifyTopic("state", "msg");
    // No fallback configs, so classifyTopic returns null after logging.
    expect(result).toBeNull();
    // The recorded error message must reference the Anthropic transport, not OpenAI.
    const combined = errorMessages.join("\n");
    expect(combined).toContain("Anthropic topic-classifier failed");
    expect(combined).not.toContain("OpenAI topic-classifier failed");
  });
});
