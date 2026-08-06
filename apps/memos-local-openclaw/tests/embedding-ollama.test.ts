import { afterEach, describe, expect, it, vi } from "vitest";

import { embedOllama } from "../src/embedding/providers/ollama";
import type { EmbeddingConfig, Logger } from "../src/types";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ollama embedding provider", () => {
  it("sends a batch to /api/embed with an embedding model default", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ embeddings: [[1, 0], [0, 1]] }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    const vectors = await embedOllama(
      ["first", "second"],
      { provider: "ollama", endpoint: "http://ollama.test/" },
      noopLog,
    );

    expect(vectors).toEqual([[1, 0], [0, 1]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://ollama.test/api/embed");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "nomic-embed-text",
      input: ["first", "second"],
    });
  });

  it("does not append /api/embed twice", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ embeddings: [[1, 0]] }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    await embedOllama(
      ["query"],
      { provider: "ollama", endpoint: "http://ollama.test/api/embed/", model: "mxbai-embed-large" },
      noopLog,
    );

    expect(fetchMock.mock.calls[0][0]).toBe("http://ollama.test/api/embed");
  });

  it("reports HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "model unavailable",
    }) as Response));

    await expect(embedOllama(
      ["query"],
      { provider: "ollama" } as EmbeddingConfig,
      noopLog,
    )).rejects.toThrow("Ollama embedding failed (503): model unavailable");
  });

  it("rejects malformed or incomplete batches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ embeddings: [[1, 0]] }),
    }) as Response));

    await expect(embedOllama(
      ["first", "second"],
      { provider: "ollama" } as EmbeddingConfig,
      noopLog,
    )).rejects.toThrow("invalid embeddings shape");
  });
});
