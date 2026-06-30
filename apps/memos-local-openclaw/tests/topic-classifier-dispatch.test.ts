import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Summarizer } from "../src/ingest/providers";
import type { Logger, SummarizerConfig } from "../src/types";

/**
 * Regression test for #1611.
 *
 * `Summarizer.classifyTopic` and `Summarizer.arbitrateTopicSplit` used to call
 * the OpenAI implementation regardless of the configured `provider`. When the
 * summarizer was wired to an Anthropic-only endpoint (e.g. Kimi Code's
 * `/coding/v1/messages`), the OpenAI-style request returned 404 and the call
 * fell through every fallback.
 *
 * These tests stub `globalThis.fetch` and assert that for each provider we
 *  1) hit the correct URL ( `/v1/messages` for anthropic, `:generateContent`
 *     for gemini, `/converse` for bedrock, `/chat/completions` for openai_*)
 *  2) send the correct request body shape (system vs system+messages vs
 *     systemInstruction vs system+messages-as-text-blocks)
 */

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Capture every fetch call so we can assert URL + body shape.
let calls: Array<{ url: string; init: RequestInit & { body?: string } }>;
let originalFetch: typeof fetch;

function installFetch(response: { ok: boolean; status?: number; body: any }): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string, init: any) => {
    calls.push({ url: typeof url === "string" ? url : String(url), init });
    return {
      ok: response.ok,
      status: response.status ?? 200,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as Response;
  }) as any;
}

function restoreFetch(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
}

describe("Summarizer.classifyTopic - provider dispatch (issue #1611)", () => {
  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    restoreFetch();
    vi.restoreAllMocks();
  });

  it("anthropic provider hits /v1/messages with system+messages body (not /chat/completions)", async () => {
    installFetch({
      ok: true,
      body: { content: [{ type: "text", text: '{"d":"S","c":0.9}' }] },
    });

    const cfg: SummarizerConfig = {
      provider: "anthropic",
      endpoint: "https://api.kimi.com/coding/v1/messages",
      apiKey: "sk-test",
      model: "kimi-for-coding",
    };
    const summarizer = new Summarizer(cfg, noopLog);

    const result = await summarizer.classifyTopic("current task state", "new message");

    expect(result).not.toBeNull();
    expect(result!.decision).toBe("SAME");
    expect(calls).toHaveLength(1);

    const [{ url, init }] = calls;
    expect(url).toBe("https://api.kimi.com/coding/v1/messages");
    expect(url).not.toContain("chat/completions");

    const body = JSON.parse(init.body as string);
    expect(body).toHaveProperty("system"); // Anthropic style
    expect(body).toHaveProperty("messages");
    expect(body).not.toHaveProperty("choices");
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("new message");
    // Anthropic must send x-api-key header, NOT Authorization
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.Authorization).toBeUndefined();
  });

  it("openai_compatible provider still hits /chat/completions (regression guard)", async () => {
    installFetch({
      ok: true,
      body: { choices: [{ message: { content: '{"d":"N","c":0.95}' } }] },
    });

    const cfg: SummarizerConfig = {
      provider: "openai_compatible",
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      apiKey: "sk-deepseek",
      model: "deepseek-chat",
    };
    const summarizer = new Summarizer(cfg, noopLog);

    const result = await summarizer.classifyTopic("ctx", "msg");

    expect(result!.decision).toBe("NEW");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/chat/completions");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toHaveProperty("messages");
    expect(body.messages[0].role).toBe("system");
  });

  it("gemini provider hits :generateContent with systemInstruction body", async () => {
    installFetch({
      ok: true,
      body: { candidates: [{ content: { parts: [{ text: '{"d":"S","c":0.8}' }] } }] },
    });

    const cfg: SummarizerConfig = {
      provider: "gemini",
      endpoint:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
      apiKey: "AIzaTEST",
      model: "gemini-1.5-flash",
    };
    const summarizer = new Summarizer(cfg, noopLog);

    const result = await summarizer.classifyTopic("ctx", "msg");

    expect(result!.decision).toBe("SAME");
    expect(calls[0].url).toContain(":generateContent");
    expect(calls[0].url).toContain("key=AIzaTEST");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toHaveProperty("systemInstruction");
    expect(body).toHaveProperty("contents");
    expect(body).not.toHaveProperty("messages");
  });

  it("bedrock provider hits /model/.../converse with system+messages body", async () => {
    installFetch({
      ok: true,
      body: { output: { message: { content: [{ text: '{"d":"S","c":0.7}' }] } } },
    });

    const cfg: SummarizerConfig = {
      provider: "bedrock",
      endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKey: "",
      model: "anthropic.claude-3-haiku-20240307-v1:0",
    };
    const summarizer = new Summarizer(cfg, noopLog);

    const result = await summarizer.classifyTopic("ctx", "msg");

    expect(result!.decision).toBe("SAME");
    expect(calls[0].url).toMatch(/\/model\/.+\/converse$/);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toHaveProperty("inferenceConfig");
    expect(body.system[0].text).toContain("Classify if NEW MESSAGE");
  });
});

describe("Summarizer.arbitrateTopicSplit - provider dispatch (issue #1611)", () => {
  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    restoreFetch();
    vi.restoreAllMocks();
  });

  it("anthropic provider hits /v1/messages (not /chat/completions)", async () => {
    installFetch({
      ok: true,
      body: { content: [{ type: "text", text: "SAME" }] },
    });

    const cfg: SummarizerConfig = {
      provider: "anthropic",
      endpoint: "https://api.kimi.com/coding/v1/messages",
      apiKey: "sk-test",
      model: "kimi-for-coding",
    };
    const summarizer = new Summarizer(cfg, noopLog);

    const result = await summarizer.arbitrateTopicSplit("ctx", "msg");

    expect(result).toBe("SAME");
    expect(calls[0].url).toBe("https://api.kimi.com/coding/v1/messages");
    expect(calls[0].url).not.toContain("chat/completions");
  });

  it("gemini provider hits :generateContent", async () => {
    installFetch({
      ok: true,
      body: { candidates: [{ content: { parts: [{ text: "NEW" }] } }] },
    });

    const cfg: SummarizerConfig = {
      provider: "gemini",
      endpoint:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
      apiKey: "AIzaTEST",
      model: "gemini-1.5-flash",
    };
    const summarizer = new Summarizer(cfg, noopLog);

    const result = await summarizer.arbitrateTopicSplit("ctx", "msg");

    expect(result).toBe("NEW");
    expect(calls[0].url).toContain(":generateContent");
  });

  it("bedrock provider hits /converse", async () => {
    installFetch({
      ok: true,
      body: { output: { message: { content: [{ text: "SAME" }] } } },
    });

    const cfg: SummarizerConfig = {
      provider: "bedrock",
      endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKey: "",
      model: "anthropic.claude-3-haiku-20240307-v1:0",
    };
    const summarizer = new Summarizer(cfg, noopLog);

    const result = await summarizer.arbitrateTopicSplit("ctx", "msg");

    expect(result).toBe("SAME");
    expect(calls[0].url).toMatch(/\/model\/.+\/converse$/);
  });

  it("anthropic 404 propagates as Anthropic error, not as OpenAI error (root cause of #1611)", async () => {
    // This is the exact failure mode reported by the user: a 404 from the
    // Anthropic endpoint. With the bug, the error message was prefixed
    // "OpenAI topic-classifier failed". After the fix it must say "Anthropic
    // topic-classifier failed" — proving we are no longer calling the OpenAI
    // helper for an Anthropic-configured summarizer.
    installFetch({
      ok: false,
      status: 404,
      body: { error: { message: "The requested resource was not found", type: "resource_not_found_error" } },
    });

    const cfg: SummarizerConfig = {
      provider: "anthropic",
      endpoint: "https://api.kimi.com/coding/v1/messages",
      apiKey: "sk-test",
      model: "kimi-for-coding",
    };
    const summarizer = new Summarizer(cfg, noopLog);

    // classifyTopic returns null on failure (tryChain swallows) but the
    // recorded model-health error message must say "Anthropic", not "OpenAI".
    const result = await summarizer.classifyTopic("ctx", "msg");
    expect(result).toBeNull();

    const { modelHealth } = await import("../src/ingest/providers");
    const entry = modelHealth.getAll().find((e) => e.role === "classifyTopic");
    expect(entry).toBeDefined();
    expect(entry!.lastErrorMessage ?? "").toContain("Anthropic");
    expect(entry!.lastErrorMessage ?? "").not.toContain("OpenAI");
  });
});
