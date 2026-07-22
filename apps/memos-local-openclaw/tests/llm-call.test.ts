import { afterEach, describe, expect, it, vi } from "vitest";

import { callLLMOnce } from "../src/shared/llm-call";
import { applyOpenRouterProviderRouting } from "../src/shared/openrouter";
import type { SummarizerConfig } from "../src/types";

describe("shared/llm-call", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports whether OpenRouter provider routing was applied", () => {
    const body: Record<string, unknown> = {};

    expect(applyOpenRouterProviderRouting({
      endpoint: "https://openrouter.ai/api/v1",
      providerIgnore: ["together"],
    }, body)).toBe(true);
    expect(body.provider).toEqual({ ignore: ["together"] });
    expect(applyOpenRouterProviderRouting({ endpoint: "https://api.openai.com/v1" }, {})).toBe(false);
  });

  it("adds OpenRouter provider preferences for OpenAI-compatible calls", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: unknown) => {
        cap.url = String(url);
        cap.init = init as RequestInit;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 },
        );
      }),
    );

    const cfg: SummarizerConfig = {
      provider: "openai_compatible",
      endpoint: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      model: "google/gemini-test",
      providerIgnore: ["together", "novita"],
      providerOrder: ["google", "anthropic"],
    };

    const result = await callLLMOnce(cfg, "summarize this");

    expect(result).toBe("ok");
    expect(cap.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(cap.init!.body as string);
    expect(body.provider).toEqual({
      ignore: ["together", "novita"],
      order: ["google", "anthropic"],
    });
  });

  it("allows an explicit OpenRouter opt-in for reverse proxies", async () => {
    const cap: { init?: RequestInit } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: unknown) => {
        cap.init = init as RequestInit;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 },
        );
      }),
    );

    const cfg = {
      provider: "openai_compatible",
      endpoint: "https://llm-proxy.example.com/v1",
      apiKey: "sk-test",
      model: "google/gemini-test",
      providerIgnore: ["together"],
      openRouter: true,
    } as SummarizerConfig;

    await callLLMOnce(cfg, "summarize this");

    const body = JSON.parse(cap.init!.body as string);
    expect(body.provider).toEqual({ ignore: ["together"] });
  });

  it("omits provider preferences for non-OpenRouter OpenAI-compatible calls", async () => {
    const cap: { init?: RequestInit } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: unknown) => {
        cap.init = init as RequestInit;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 },
        );
      }),
    );

    const cfg: SummarizerConfig = {
      provider: "openai_compatible",
      endpoint: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-test",
      providerIgnore: ["together"],
      providerOrder: ["google"],
    };

    await callLLMOnce(cfg, "summarize this");

    const body = JSON.parse(cap.init!.body as string);
    expect("provider" in body).toBe(false);
  });
});
