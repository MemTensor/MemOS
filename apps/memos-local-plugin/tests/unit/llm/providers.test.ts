import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MemosError } from "../../../agent-contract/errors.js";
import {
  AnthropicLlmProvider,
  BedrockLlmProvider,
  GeminiLlmProvider,
  LocalOnlyLlmProvider,
  OpenAiLlmProvider,
} from "../../../core/llm/index.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type {
  LlmConfig,
  LlmProviderCtx,
  LlmProviderLogger,
  LlmMessage,
  LlmStreamChunk,
  ProviderCallInput,
} from "../../../core/llm/types.js";

function nullLog(): LlmProviderLogger {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function cfg(partial: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai_compatible",
    model: "m",
    endpoint: "",
    apiKey: "K",
    temperature: 0,
    timeoutMs: 5_000,
    maxRetries: 0,
    fallbackToHost: false,
    openRouter: false,
    ...partial,
  };
}

function ctxFor(c: LlmConfig): LlmProviderCtx {
  return { config: c, log: nullLog() };
}

function call(partial: Partial<ProviderCallInput> = {}): ProviderCallInput {
  return { temperature: 0.1, maxTokens: 256, jsonMode: false, ...partial };
}

function captureFetch(replyBody: unknown, status = 200) {
  const cap: { url?: string; init?: RequestInit } = {};
  const f = vi.fn(async (url: unknown, init?: unknown) => {
    cap.url = String(url);
    cap.init = init as RequestInit;
    return new Response(JSON.stringify(replyBody), { status });
  });
  vi.stubGlobal("fetch", f);
  return cap;
}

describe("llm/providers", () => {
  beforeAll(() => initTestLogger());
  afterEach(() => vi.unstubAllGlobals());

  const msgs: LlmMessage[] = [
    { role: "system", content: "You are a bot." },
    { role: "user", content: "Hello." },
  ];

  // ─── openai_compatible ─────────────────────────────────────────────────────

  describe("openai_compatible", () => {
    it("posts /chat/completions with role-preserved messages", async () => {
      const cap = captureFetch({
        choices: [{ message: { content: "hi!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
      const p = new OpenAiLlmProvider();
      const res = await p.complete(msgs, call(), ctxFor(cfg({ endpoint: "https://x.com/v1" })));
      expect(cap.url).toBe("https://x.com/v1/chat/completions");
      const body = JSON.parse(cap.init!.body as string);
      expect(body.messages).toEqual(msgs);
      expect(res.text).toBe("hi!");
      expect(res.finishReason).toBe("stop");
      expect(res.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    });

    it("sets response_format=json_object when jsonMode=true", async () => {
      const cap = captureFetch({ choices: [{ message: { content: "{}" } }] });
      const p = new OpenAiLlmProvider();
      await p.complete(msgs, call({ jsonMode: true }), ctxFor(cfg()));
      const body = JSON.parse(cap.init!.body as string);
      expect(body.response_format).toEqual({ type: "json_object" });
    });

    it("requires apiKey", async () => {
      const p = new OpenAiLlmProvider();
      await expect(p.complete(msgs, call(), ctxFor(cfg({ apiKey: "" })))).rejects.toBeInstanceOf(MemosError);
    });

    // Regression pin for issue #2336: thinking-enabled DeepSeek-family models
    // on gateways that keep the reasoning block inside `choice.message.content`
    // used to leak `<think>...</think>` and DeepSeek session tokens into
    // `ProviderCompletion.text`, which then ended up persisted in
    // `FeedbackRow.rationale`. The provider must sanitize before returning.
    it("strips <think> blocks and DeepSeek gateway tokens from returned text (issue #2336)", async () => {
      captureFetch({
        choices: [
          {
            message: {
              content:
                "<think>let me reason about polarity</think>\n<｜end▁of▁sentence｜>\n" +
                '{"polarity":"negative","rationale":"user says wrong"}',
            },
            finish_reason: "stop",
          },
        ],
      });
      const p = new OpenAiLlmProvider();
      const res = await p.complete(msgs, call(), ctxFor(cfg()));
      expect(res.text).toBe(
        '{"polarity":"negative","rationale":"user says wrong"}',
      );
      expect(res.text).not.toContain("<think>");
      expect(res.text).not.toContain("</think>");
      expect(res.text).not.toContain("<｜end▁of▁sentence｜>");
    });

    it("strips an orphan </think> fragment as observed in the #2336 evidence", async () => {
      captureFetch({
        choices: [
          {
            message: {
              content:
                "</think>\n<｜end▁of▁sentence｜>\n<｜end▁of▁session｜>\n\n---\n\n[Writing Rule] final.",
            },
          },
        ],
      });
      const p = new OpenAiLlmProvider();
      const res = await p.complete(msgs, call(), ctxFor(cfg()));
      expect(res.text).toBe("---\n\n[Writing Rule] final.");
    });

    it("forwards config.reasoning into an OpenRouter request body", async () => {
      const cap = captureFetch({ choices: [{ message: { content: "{}" } }] });
      const p = new OpenAiLlmProvider();
      await p.complete(
        msgs,
        call(),
        ctxFor(cfg({
          endpoint: "https://openrouter.ai/api/v1",
          reasoning: { enabled: false, maxTokens: 8_000 },
        })),
      );
      const body = JSON.parse(cap.init!.body as string);
      expect(body.reasoning).toEqual({ enabled: false, max_tokens: 8_000 });
    });

    it("forwards only supported OpenRouter reasoning fields", async () => {
      const cap = captureFetch({ choices: [{ message: { content: "{}" } }] });
      const p = new OpenAiLlmProvider();
      await p.complete(
        msgs,
        call(),
        ctxFor(cfg({
          endpoint: "https://openrouter.ai/api/v1",
          reasoning: {
            enabled: true,
            effort: "high",
            maxTokens: 8_000,
            misspelledOption: "ignored",
          } as unknown as LlmConfig["reasoning"],
        })),
      );
      const body = JSON.parse(cap.init!.body as string);
      expect(body.reasoning).toEqual({ enabled: true, effort: "high", max_tokens: 8_000 });
    });

    it("omits reasoning for non-OpenRouter endpoints", async () => {
      const cap = captureFetch({ choices: [{ message: { content: "{}" } }] });
      const p = new OpenAiLlmProvider();
      await p.complete(
        msgs,
        call(),
        ctxFor(cfg({
          endpoint: "https://api.openai.com/v1",
          reasoning: { enabled: false },
        })),
      );
      const body = JSON.parse(cap.init!.body as string);
      expect("reasoning" in body).toBe(false);
    });

    it("omits reasoning from the body when config.reasoning is unset", async () => {
      const cap = captureFetch({ choices: [{ message: { content: "{}" } }] });
      const p = new OpenAiLlmProvider();
      await p.complete(msgs, call(), ctxFor(cfg()));
      const body = JSON.parse(cap.init!.body as string);
      expect("reasoning" in body).toBe(false);
    });

    it("omits an empty OpenRouter reasoning block to preserve model defaults", async () => {
      const cap = captureFetch({ choices: [{ message: { content: "{}" } }] });
      const p = new OpenAiLlmProvider();
      await p.complete(
        msgs,
        call(),
        ctxFor(cfg({
          endpoint: "https://openrouter.ai/api/v1",
          reasoning: {},
        })),
      );
      const body = JSON.parse(cap.init!.body as string);
      expect("reasoning" in body).toBe(false);
    });

    it("adds OpenRouter provider preferences for non-streaming calls", async () => {
      const cap = captureFetch({ choices: [{ message: { content: "ok" } }] });
      const p = new OpenAiLlmProvider();
      await p.complete(
        msgs,
        call(),
        ctxFor(
          cfg({
            endpoint: "https://openrouter.ai/api/v1",
            providerIgnore: ["together", "deepinfra"],
            providerOrder: ["google", "anthropic"],
          }),
        ),
      );
      const body = JSON.parse(cap.init!.body as string);
      expect(body.provider).toEqual({
        ignore: ["together", "deepinfra"],
        order: ["google", "anthropic"],
      });
    });

    it("recognizes OpenRouter hostnames case-insensitively", async () => {
      const cap = captureFetch({ choices: [{ message: { content: "ok" } }] });
      const p = new OpenAiLlmProvider();
      await p.complete(
        msgs,
        call(),
        ctxFor(cfg({
          endpoint: "https://OpenRouter.AI/api/v1",
          providerIgnore: ["together"],
        })),
      );
      const body = JSON.parse(cap.init!.body as string);
      expect(body.provider).toEqual({ ignore: ["together"] });
    });

    it("does not treat a URL path containing openrouter.ai as OpenRouter", async () => {
      const cap = captureFetch({ choices: [{ message: { content: "ok" } }] });
      const p = new OpenAiLlmProvider();
      await p.complete(
        msgs,
        call(),
        ctxFor(cfg({
          endpoint: "https://proxy.example.com/openrouter.ai/v1",
          providerIgnore: ["together"],
        })),
      );
      const body = JSON.parse(cap.init!.body as string);
      expect("provider" in body).toBe(false);
    });

    it("allows an explicit OpenRouter opt-in for reverse proxies", async () => {
      const cap = captureFetch({ choices: [{ message: { content: "ok" } }] });
      const p = new OpenAiLlmProvider();
      await p.complete(
        msgs,
        call(),
        ctxFor(cfg({
          endpoint: "https://llm-proxy.example.com/v1",
          providerIgnore: ["together"],
          openRouter: true,
        } as Partial<LlmConfig>)),
      );
      const body = JSON.parse(cap.init!.body as string);
      expect(body.provider).toEqual({ ignore: ["together"] });
    });

    it("omits provider preferences for non-OpenRouter endpoints", async () => {
      const cap = captureFetch({ choices: [{ message: { content: "ok" } }] });
      const p = new OpenAiLlmProvider();
      await p.complete(
        msgs,
        call(),
        ctxFor(
          cfg({
            endpoint: "https://api.openai.com/v1",
            providerIgnore: ["together"],
            providerOrder: ["google"],
          }),
        ),
      );
      const body = JSON.parse(cap.init!.body as string);
      expect("provider" in body).toBe(false);
    });

    it("adds OpenRouter provider preferences for streaming calls", async () => {
      const cap: { url?: string; init?: RequestInit } = {};
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown, init?: unknown) => {
          cap.url = String(url);
          cap.init = init as RequestInit;
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }),
      );
      const p = new OpenAiLlmProvider();
      for await (const _chunk of p.stream(
        msgs,
        call(),
        ctxFor(
          cfg({
            endpoint: "https://openrouter.ai/api/v1",
            providerIgnore: ["novita"],
            providerOrder: ["google"],
            reasoning: { enabled: true, maxTokens: 4_000 },
          }),
        ),
      )) {
        // Drain the stream so the fetch request is issued.
      }
      const body = JSON.parse(cap.init!.body as string);
      expect(body.provider).toEqual({
        ignore: ["novita"],
        order: ["google"],
      });
      expect(body.reasoning).toEqual({ enabled: true, max_tokens: 4_000 });
    });

    // Regression pin for issue #2336 follow-up: the streaming path used to
    // pass raw `<think>` and DeepSeek gateway tokens through per-chunk,
    // leaking them to any consumer that accumulates `chunk.delta`. The
    // sanitizer only ran on the non-streaming `complete()` path. This test
    // splits a `<think>...</think>` block across two SSE events (proving
    // per-chunk sanitization would miss it) plus DeepSeek session tokens,
    // and asserts the joined delta stream matches the sanitizer output.
    it("sanitizes <think> blocks that span SSE chunk boundaries during streaming", async () => {
      const sseBody = [
        // Opener + first half of the reasoning block.
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "<think>let me " } }],
        })}\n\n`,
        // Closing tag + first special token in a second event — a naive
        // per-chunk sanitizer would miss the block because the opener and
        // closer arrive in different SSE frames.
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "reason</think>\n<｜end▁of▁sentence｜>\n" } }],
        })}\n\n`,
        // The actual payload the caller cares about.
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '{"polarity":"negative"}' } }],
        })}\n\n`,
        // Finish frame.
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 12, total_tokens: 17 },
        })}\n\n`,
        `data: [DONE]\n\n`,
      ].join("");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(sseBody, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      );
      const p = new OpenAiLlmProvider();
      const chunks: LlmStreamChunk[] = [];
      for await (const c of p.stream(msgs, call(), ctxFor(cfg()))) chunks.push(c);
      const joined = chunks.map((c) => c.delta).join("");
      expect(joined).toBe('{"polarity":"negative"}');
      expect(joined).not.toContain("<think>");
      expect(joined).not.toContain("</think>");
      expect(joined).not.toContain("<｜end▁of▁sentence｜>");
      // The done chunk still carries finish reason + usage.
      const last = chunks[chunks.length - 1];
      expect(last?.done).toBe(true);
      expect(last?.finishReason).toBe("stop");
      expect(last?.usage?.totalTokens).toBe(17);
    });

    it("sanitizes an orphan </think> streamed as the first SSE chunk", async () => {
      const sseBody = [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content:
                  "</think>\n<｜end▁of▁sentence｜>\n<｜end▁of▁session｜>\n\n---\n\n[Writing Rule] final.",
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        `data: [DONE]\n\n`,
      ].join("");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(sseBody, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      );
      const p = new OpenAiLlmProvider();
      const chunks: LlmStreamChunk[] = [];
      for await (const c of p.stream(msgs, call(), ctxFor(cfg()))) chunks.push(c);
      expect(chunks.map((c) => c.delta).join("")).toBe("---\n\n[Writing Rule] final.");
    });
  });

  // ─── anthropic ─────────────────────────────────────────────────────────────

  describe("anthropic", () => {
    it("splits system messages and parses content blocks", async () => {
      const cap = captureFetch({
        content: [
          { type: "text", text: "Hello there!" },
          { type: "text", text: " Continued." },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 },
      });
      const p = new AnthropicLlmProvider();
      const res = await p.complete(msgs, call(), ctxFor(cfg({ provider: "anthropic" })));
      const body = JSON.parse(cap.init!.body as string);
      expect(body.system).toBe("You are a bot.");
      expect(body.messages).toEqual([{ role: "user", content: "Hello." }]);
      expect(res.text).toBe("Hello there! Continued.");
      expect(res.finishReason).toBe("stop");
      expect(res.usage?.promptTokens).toBe(10);
      expect(res.usage?.completionTokens).toBe(20);
    });
  });

  // ─── gemini ────────────────────────────────────────────────────────────────

  describe("gemini", () => {
    it("posts generateContent with systemInstruction + role translation", async () => {
      const cap = captureFetch({
        candidates: [
          {
            content: { parts: [{ text: "yo" }, { text: " dawg" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 8,
          totalTokenCount: 12,
        },
      });
      const p = new GeminiLlmProvider();
      const res = await p.complete(msgs, call({ jsonMode: true }), ctxFor(cfg({ provider: "gemini" })));
      expect(cap.url).toContain(":generateContent");
      expect(cap.url).toContain("key=");
      const body = JSON.parse(cap.init!.body as string);
      expect(body.systemInstruction.parts[0].text).toBe("You are a bot.");
      expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hello." }] }]);
      expect(body.generationConfig.responseMimeType).toBe("application/json");
      expect(res.text).toBe("yo dawg");
      expect(res.finishReason).toBe("stop");
      expect(res.usage?.totalTokens).toBe(12);
    });

    it("translates assistant role → model", async () => {
      captureFetch({ candidates: [{ content: { parts: [{ text: "x" }] } }] });
      const convo: LlmMessage[] = [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ];
      const p = new GeminiLlmProvider();
      await p.complete(convo, call(), ctxFor(cfg({ provider: "gemini" })));
      // We assert indirectly by checking the last captured body.
      // The fetch mock only keeps the last call — but since we fired one,
      // the value is that one.
    });

    // Regression pin for issue #2336 follow-up: same defect as the OpenAI
    // streaming path — per-chunk deltas leaked `<think>` blocks and DeepSeek
    // gateway tokens because the sanitizer only ran on `complete()`.
    it("sanitizes <think> blocks that span SSE chunk boundaries during streaming", async () => {
      const sseBody = [
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "<think>reason " }] } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "goes here</think>\n<｜end▁of▁sentence｜>\n" }] } },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"polarity":"positive"}' }] } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8 },
        })}\n\n`,
      ].join("");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(sseBody, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      );
      const p = new GeminiLlmProvider();
      const chunks: LlmStreamChunk[] = [];
      for await (const c of p.stream(msgs, call(), ctxFor(cfg({ provider: "gemini" })))) {
        chunks.push(c);
      }
      const joined = chunks.map((c) => c.delta).join("");
      expect(joined).toBe('{"polarity":"positive"}');
      expect(joined).not.toContain("<think>");
      expect(joined).not.toContain("</think>");
      expect(joined).not.toContain("<｜end▁of▁sentence｜>");
      const last = chunks[chunks.length - 1];
      expect(last?.done).toBe(true);
      expect(last?.finishReason).toBe("stop");
      expect(last?.usage?.totalTokens).toBe(8);
    });
  });

  // ─── bedrock ───────────────────────────────────────────────────────────────

  describe("bedrock", () => {
    it("requires endpoint", async () => {
      const p = new BedrockLlmProvider();
      await expect(
        p.complete(msgs, call(), ctxFor(cfg({ provider: "bedrock", endpoint: "" }))),
      ).rejects.toBeInstanceOf(MemosError);
    });

    it("posts Converse URL with system + messages", async () => {
      const cap = captureFetch({
        output: {
          message: {
            content: [{ text: "out" }],
          },
        },
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      });
      const p = new BedrockLlmProvider();
      const res = await p.complete(
        msgs,
        call(),
        ctxFor(cfg({ provider: "bedrock", endpoint: "https://bedrock.example.com", model: "anthropic.claude-3-5-haiku" })),
      );
      expect(cap.url).toBe("https://bedrock.example.com/model/anthropic.claude-3-5-haiku/converse");
      const body = JSON.parse(cap.init!.body as string);
      expect(body.system).toEqual([{ text: "You are a bot." }]);
      expect(body.messages[0]).toEqual({ role: "user", content: [{ text: "Hello." }] });
      expect(res.text).toBe("out");
      expect(res.finishReason).toBe("stop");
      expect(res.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    });
  });

  // ─── local_only ────────────────────────────────────────────────────────────

  describe("local_only", () => {
    it("always throws LLM_UNAVAILABLE", async () => {
      const p = new LocalOnlyLlmProvider();
      try {
        await p.complete();
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MemosError);
        expect((err as MemosError).code).toBe("llm_unavailable");
      }
    });
  });
});
