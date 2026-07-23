import { afterEach, describe, expect, it, vi } from "vitest";

import { Embedder } from "../src/embedding";
import type { EmbeddingConfig, Logger } from "../src/types";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function mockEmbeddingFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return {
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return bodies;
}

function openAiConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    provider: "openai_compatible",
    endpoint: "https://embeddings.example.test/v1",
    apiKey: "test-key",
    model: "asymmetric-model",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedding input_type routing", () => {
  it("uses documentInputType for document embeddings and queryInputType for query embeddings", async () => {
    const bodies = mockEmbeddingFetch();
    const embedder = new Embedder(
      openAiConfig({
        inputType: "passage",
        documentInputType: "document",
        queryInputType: "query",
      }),
      noopLog,
    );

    await embedder.embed(["stored memory"]);
    await embedder.embedQuery("search terms");

    expect(bodies[0]).toMatchObject({ input_type: "document" });
    expect(bodies[1]).toMatchObject({ input_type: "query" });
  });

  it("falls back to inputType when a specific query or document input type is absent", async () => {
    const bodies = mockEmbeddingFetch();
    const embedder = new Embedder(openAiConfig({ inputType: "passage" }), noopLog);

    await embedder.embed(["stored memory"]);
    await embedder.embedQuery("search terms");

    expect(bodies[0]).toMatchObject({ input_type: "passage" });
    expect(bodies[1]).toMatchObject({ input_type: "passage" });
  });
});
