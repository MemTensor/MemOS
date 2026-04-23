import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MemosError } from "../../../agent-contract/errors.js";
import {
  CohereEmbeddingProvider,
  GeminiEmbeddingProvider,
  MistralEmbeddingProvider,
  OpenAiEmbeddingProvider,
  VoyageEmbeddingProvider,
} from "../../../core/embedding/index.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type {
  EmbeddingConfig,
  ProviderCallCtx,
  ProviderLogger,
} from "../../../core/embedding/types.js";

function nullLogger(): ProviderLogger {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function cfg(partial: Partial<EmbeddingConfig>): EmbeddingConfig {
  return {
    provider: "openai_compatible",
    model: "m",
    dimensions: 3,
    endpoint: "",
    apiKey: "KEY",
    cache: { enabled: false, maxItems: 0 },
    ...partial,
  } as EmbeddingConfig;
}

function ctxFor(c: EmbeddingConfig): ProviderCallCtx {
  return { config: c, log: nullLogger() };
}

function mockResponses(responses: Array<Response | Error>) {
  let i = 0;
  const f = vi.fn(async (_url: unknown, _init?: unknown) => {
    const r = responses[i++];
    if (!r) throw new Error("mockResponses exhausted");
    if (r instanceof Error) throw r;
    return r;
  });
  vi.stubGlobal("fetch", f);
  return f;
}

/**
 * Capture the outgoing URL + body and reply with a provider-specific shape.
 * Providers differ on response parsing, so each test should pass the right
 * `body` here.
 */
function captureFetchRequest(
  replyBody: unknown = { data: [{ embedding: [1, 0, 0] }] },
) {
  const captured: { url?: string; init?: RequestInit } = {};
  const f = vi.fn(async (url: unknown, init?: unknown) => {
    captured.url = String(url);
    captured.init = init as RequestInit;
    return new Response(JSON.stringify(replyBody), { status: 200 });
  });
  vi.stubGlobal("fetch", f);
  return captured;
}

describe("embedding/providers", () => {
  beforeAll(() => initTestLogger());
  afterEach(() => vi.unstubAllGlobals());

  // ─── OpenAI-compatible ─────────────────────────────────────────────────────

  describe("openai_compatible", () => {
    it("requires apiKey", async () => {
      const p = new OpenAiEmbeddingProvider();
      await expect(
        p.embed(["x"], "document", ctxFor(cfg({ apiKey: "" }))),
      ).rejects.toBeInstanceOf(MemosError);
    });

    it("posts { input, model } and parses data[].embedding", async () => {
      mockResponses([
        new Response(
          JSON.stringify({
            data: [
              { embedding: [0.1, 0.2, 0.3] },
              { embedding: [0.4, 0.5, 0.6] },
            ],
          }),
          { status: 200 },
        ),
      ]);
      const p = new OpenAiEmbeddingProvider();
      const out = await p.embed(
        ["a", "b"],
        "document",
        ctxFor(cfg({ provider: "openai_compatible", model: "text-embedding-3-small" })),
      );
      expect(out).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
    });

    it("normalizes endpoint without /embeddings suffix", async () => {
      const cap = captureFetchRequest();
      const p = new OpenAiEmbeddingProvider();
      await p.embed(
        ["a"],
        "document",
        ctxFor(cfg({ provider: "openai_compatible", endpoint: "https://x.example.com/v1" })),
      );
      expect(cap.url).toBe("https://x.example.com/v1/embeddings");
    });

    it("keeps endpoint ending with /embeddings intact", async () => {
      const cap = captureFetchRequest();
      const p = new OpenAiEmbeddingProvider();
      await p.embed(
        ["a"],
        "document",
        ctxFor(cfg({ provider: "openai_compatible", endpoint: "https://x.example.com/embeddings" })),
      );
      expect(cap.url).toBe("https://x.example.com/embeddings");
    });

    it("rejects malformed response (no data[])", async () => {
      mockResponses([
        new Response(JSON.stringify({ notdata: true }), { status: 200 }),
      ]);
      const p = new OpenAiEmbeddingProvider();
      await expect(
        p.embed(["a"], "document", ctxFor(cfg({ provider: "openai_compatible" }))),
      ).rejects.toBeInstanceOf(MemosError);
    });
  });

  // ─── Gemini ────────────────────────────────────────────────────────────────

  describe("gemini", () => {
    const geminiReply = { embeddings: [{ values: [1, 0, 0] }] };

    it("sets taskType=RETRIEVAL_DOCUMENT for documents", async () => {
      const cap = captureFetchRequest(geminiReply);
      const p = new GeminiEmbeddingProvider();
      await p.embed(["doc"], "document", ctxFor(cfg({ provider: "gemini", model: "text-embedding-004" })));
      const body = JSON.parse(cap.init!.body as string);
      expect(body.requests[0].taskType).toBe("RETRIEVAL_DOCUMENT");
      expect(String(cap.url)).toContain(":batchEmbedContents");
      expect(String(cap.url)).toContain("key=");
    });

    it("sets taskType=RETRIEVAL_QUERY for queries", async () => {
      const cap = captureFetchRequest(geminiReply);
      const p = new GeminiEmbeddingProvider();
      await p.embed(["q"], "query", ctxFor(cfg({ provider: "gemini" })));
      const body = JSON.parse(cap.init!.body as string);
      expect(body.requests[0].taskType).toBe("RETRIEVAL_QUERY");
    });

    it("parses embeddings[].values", async () => {
      mockResponses([
        new Response(
          JSON.stringify({ embeddings: [{ values: [1, 2, 3] }, { values: [4, 5, 6] }] }),
          { status: 200 },
        ),
      ]);
      const p = new GeminiEmbeddingProvider();
      const out = await p.embed(["a", "b"], "document", ctxFor(cfg({ provider: "gemini" })));
      expect(out).toEqual([
        [1, 2, 3],
        [4, 5, 6],
      ]);
    });
  });

  // ─── Cohere ────────────────────────────────────────────────────────────────

  describe("cohere", () => {
    it("uses search_document vs search_query based on role", async () => {
      const cohereReply = { embeddings: [[1, 0, 0]] };
      const cap = captureFetchRequest(cohereReply);
      const p = new CohereEmbeddingProvider();
      await p.embed(["a"], "document", ctxFor(cfg({ provider: "cohere" })));
      const body1 = JSON.parse(cap.init!.body as string);
      expect(body1.input_type).toBe("search_document");

      const cap2 = captureFetchRequest(cohereReply);
      await p.embed(["b"], "query", ctxFor(cfg({ provider: "cohere" })));
      const body2 = JSON.parse(cap2.init!.body as string);
      expect(body2.input_type).toBe("search_query");
    });

    it("parses embeddings[]", async () => {
      mockResponses([
        new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 }),
      ]);
      const p = new CohereEmbeddingProvider();
      const out = await p.embed(["a"], "document", ctxFor(cfg({ provider: "cohere", dimensions: 2 })));
      expect(out).toEqual([[1, 2]]);
    });
  });

  // ─── Voyage ────────────────────────────────────────────────────────────────

  describe("voyage", () => {
    it("parses data[].embedding + sets input_type by role", async () => {
      const cap = captureFetchRequest();
      const p = new VoyageEmbeddingProvider();
      await p.embed(["a"], "query", ctxFor(cfg({ provider: "voyage" })));
      const body = JSON.parse(cap.init!.body as string);
      expect(body.input_type).toBe("query");
      expect(body.model).toBe("m");

      mockResponses([
        new Response(JSON.stringify({ data: [{ embedding: [9] }] }), { status: 200 }),
      ]);
      const out = await p.embed(["a"], "document", ctxFor(cfg({ provider: "voyage", dimensions: 1 })));
      expect(out).toEqual([[9]]);
    });
  });

  // ─── Mistral ───────────────────────────────────────────────────────────────

  describe("mistral", () => {
    it("parses openai-shape data[].embedding", async () => {
      mockResponses([
        new Response(JSON.stringify({ data: [{ embedding: [7, 8, 9] }] }), { status: 200 }),
      ]);
      const p = new MistralEmbeddingProvider();
      const out = await p.embed(["a"], "document", ctxFor(cfg({ provider: "mistral", dimensions: 3 })));
      expect(out).toEqual([[7, 8, 9]]);
    });

    it("rejects missing apiKey", async () => {
      const p = new MistralEmbeddingProvider();
      await expect(
        p.embed(["a"], "document", ctxFor(cfg({ provider: "mistral", apiKey: "" }))),
      ).rejects.toBeInstanceOf(MemosError);
    });
  });
});
