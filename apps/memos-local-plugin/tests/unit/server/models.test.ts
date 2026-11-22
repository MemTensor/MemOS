import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GEMINI_MODEL } from "../../../core/llm/providers/gemini.js";
import { probeChat, probeLocalEmbedding } from "../../../server/routes/models.js";

describe("chat model probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The Settings "test" button must probe the model real calls use when
  // the model field is empty, or a passing test proves nothing.
  it("probes the provider's default Gemini model when none is given", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeChat({ provider: "gemini", apiKey: "k" })).resolves.toBe(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    );
  });
});

describe("local embedding model probe", () => {
  it("tests unsaved local model source and offline settings", async () => {
    const create = vi.fn(() => ({ embedOne: vi.fn(async () => Float32Array.from([1, 0])) }));
    const local = { remoteHost: "https://mirror.example/", modelPath: "/models", offline: true };
    await expect(probeLocalEmbedding("test/model", create, local)).resolves.toBe(2);
    expect(create).toHaveBeenCalledWith("test/model", local);
  });
  it("loads the default MiniLM model and verifies a real vector", async () => {
    const embedOne = vi.fn(async () => Float32Array.from([0.1, 0.2, 0.3]));
    const create = vi.fn(() => ({ embedOne }));

    await expect(probeLocalEmbedding("", create)).resolves.toBe(3);
    expect(create).toHaveBeenCalledWith("Xenova/all-MiniLM-L6-v2");
    expect(embedOne).toHaveBeenCalledWith("ping");
  });

  it("surfaces download/load guidance on failure", async () => {
    const embedOne = vi.fn(async () => {
      throw new Error("fetch failed");
    });

    await expect(
      probeLocalEmbedding("custom/minilm", () => ({ embedOne })),
    ).rejects.toThrow(
      "Local embedding model download/load failed; check access to Hugging Face: fetch failed",
    );
  });
});
